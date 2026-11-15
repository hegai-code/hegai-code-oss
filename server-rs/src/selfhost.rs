//! Pieces a self-hosted hub needs and the internal one does not notice:
//! installers that point at THIS hub, a trusted-proxy list for client
//! addresses, and legal pages the customer owns.
//!
//! Everything here is a no-op for the internal hub (`code.acme.test`): the
//! installers already say that name, the proxy is loopback nginx, and the legal
//! pages are the embedded Hegai ones.

use std::net::IpAddr;
use std::path::Path;
use std::sync::OnceLock;

use axum::http::header;
use axum::response::{Html, IntoResponse, Response};

/// The name every installer script has baked in. Public so the test can pin it.
pub const BAKED_HOST: &str = "code.acme.test";

/// Point an installer at the hub that serves it.
///
/// The scripts are written for `code.acme.test` (`https://…`, `wss://…` and the
/// bare name in prose such as «approve it on code.acme.test/link»). A customer's
/// hub answers on its own name, so the three spellings are replaced with
/// `public_url` (`https://host`, `wss://host`, `host`). For the internal hub
/// `public_url` IS `https://code.acme.test` and the text is returned untouched.
pub fn localize_installer(script: &str, public_url: &str) -> String {
    let base = public_url.trim().trim_end_matches('/');
    let (ws_base, host) = match base.split_once("://") {
        Some(("https", rest)) => (format!("wss://{rest}"), rest),
        Some(("http", rest)) => (format!("ws://{rest}"), rest),
        _ => return script.to_string(),
    };
    if host.is_empty() || host.eq_ignore_ascii_case(BAKED_HOST) {
        return script.to_string();
    }
    // A line tagged `vendor-literal` names Hegai's own host on purpose and is
    // left alone: the desktop builds are served from `code.acme.test/dl` only
    // (a customer's hub has no /dl), and the scripts compare the chosen hub
    // against the vendor default.
    script
        .split_inclusive('\n')
        .map(|line| {
            if line.contains(VENDOR_LITERAL) {
                line.to_string()
            } else {
                line.replace(&format!("wss://{BAKED_HOST}"), &ws_base)
                    .replace(&format!("https://{BAKED_HOST}"), base)
                    .replace(BAKED_HOST, host)
            }
        })
        .collect()
}

/// Marker a script line carries to keep `code.acme.test` through localization.
pub const VENDOR_LITERAL: &str = "vendor-literal";

/// `CC_REMOTE_APP_DL`: where the hub's desktop-app installers download the
/// signed builds from (a URL ending in the directory that holds
/// `HegaiCode-mac.zip` / `HegaiCode-win-setup.exe`). Unset = the vendor
/// default baked into the scripts. A self-hosted hub has no `/dl` of its own,
/// and the public source snapshot does not name the vendor's host, so its
/// operator sets this. Read once; an invalid value is ignored (logged).
pub fn app_download_base() -> Option<&'static str> {
    static DL: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    DL.get_or_init(|| {
        let raw = std::env::var("CC_REMOTE_APP_DL").ok()?;
        let v = parse_app_download_base(&raw);
        if v.is_none() && !raw.trim().is_empty() {
            eprintln!(
                "[selfhost] CC_REMOTE_APP_DL is not an https URL of plain characters — ignored"
            );
        }
        v
    })
    .as_deref()
}

/// The value is pasted into a bash and a PowerShell string, so only a plain
/// https URL (no quotes, spaces, `$`, backticks, `;`…) is accepted.
fn parse_app_download_base(raw: &str) -> Option<String> {
    let v = raw.trim().trim_end_matches('/');
    let rest = v.strip_prefix("https://")?;
    let host = rest.split('/').next().unwrap_or("");
    let plain = |c: char| c.is_ascii_alphanumeric() || "-._~/:%".contains(c);
    let parsed = reqwest::Url::parse(v).ok()?;
    let well_formed = parsed.scheme() == "https" && parsed.host_str().is_some();
    (well_formed && !host.is_empty() && !host.starts_with(':') && rest.chars().all(plain))
        .then(|| v.to_string())
}

/// Point the vendor download default of a (localized) installer at `dl`.
/// Only the tagged `vendor-literal` lines carry `https://<baked>/dl`.
pub fn point_app_downloads(script: &str, dl: &str) -> String {
    script.replace(&format!("https://{BAKED_HOST}/dl"), dl)
}

/// The fleet token guards every machine of a customer's fleet and a short one is
/// brute-forceable, so the external edition refuses to start on anything under
/// 32 characters (`deploy/selfhost/init.sh` generates 64). The internal hub is
/// unchanged: its token is provisioned by systemd drop-ins we control.
pub fn weak_external_token(token: &str, external: bool) -> Option<String> {
    (external && token.len() < MIN_EXTERNAL_TOKEN)
        .then(|| format!("CC_REMOTE_TOKEN must be at least {MIN_EXTERNAL_TOKEN} characters (generate one: openssl rand -hex 32)"))
}

const MIN_EXTERNAL_TOKEN: usize = 32;

/// One entry of `CC_REMOTE_TRUSTED_PROXIES`: an address or a CIDR block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Net {
    addr: IpAddr,
    prefix: u8,
}

impl Net {
    fn parse(raw: &str) -> Option<Net> {
        let raw = raw.trim();
        let (addr, prefix) = match raw.split_once('/') {
            Some((a, p)) => (
                a.trim().parse::<IpAddr>().ok()?,
                Some(p.trim().parse::<u8>().ok()?),
            ),
            None => (raw.parse::<IpAddr>().ok()?, None),
        };
        let addr = addr.to_canonical();
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(max);
        (prefix <= max).then_some(Net { addr, prefix })
    }

    fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => mask_eq(
                u32::from(net) as u128,
                u32::from(ip) as u128,
                self.prefix,
                32,
            ),
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                mask_eq(u128::from(net), u128::from(ip), self.prefix, 128)
            }
            _ => false,
        }
    }
}

fn mask_eq(a: u128, b: u128, prefix: u8, bits: u8) -> bool {
    if prefix == 0 {
        return true;
    }
    let shift = u32::from(bits - prefix);
    (a >> shift) == (b >> shift)
}

/// Reverse proxies whose `X-Real-IP` the hub believes. Loopback always is (the
/// internal nginx); `CC_REMOTE_TRUSTED_PROXIES` adds the proxy of a container
/// network, e.g. `172.16.0.0/12`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustedProxies(Vec<Net>);

impl TrustedProxies {
    /// Comma-separated addresses / CIDR blocks. Junk entries are dropped (see
    /// `rejected`), never trusted.
    pub fn parse(raw: &str) -> TrustedProxies {
        TrustedProxies(raw.split(',').filter_map(Net::parse).collect())
    }

    /// Entries of `raw` that are not an address or a CIDR block.
    pub fn rejected(raw: &str) -> Vec<String> {
        raw.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty() && Net::parse(s).is_none())
            .map(str::to_string)
            .collect()
    }

    pub fn trusts(&self, peer: IpAddr) -> bool {
        peer.to_canonical().is_loopback() || self.0.iter().any(|n| n.contains(peer))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

static TRUSTED: OnceLock<TrustedProxies> = OnceLock::new();

/// The process-wide list, read once from `CC_REMOTE_TRUSTED_PROXIES`.
pub fn trusted_proxies() -> &'static TrustedProxies {
    TRUSTED.get_or_init(|| {
        let raw = std::env::var("CC_REMOTE_TRUSTED_PROXIES").unwrap_or_default();
        for bad in TrustedProxies::rejected(&raw) {
            eprintln!("[hub] CC_REMOTE_TRUSTED_PROXIES: ignoring {bad:?} (not an IP or CIDR)");
        }
        TrustedProxies::parse(&raw)
    })
}

/// A legal page of the external edition, by file stem (`privacy`, `support`,
/// `delete-account`): `<CC_REMOTE_LEGAL_DIR>/<stem>.html` when the operator
/// supplies one, else a neutral notice. The internal edition never calls this.
pub fn external_legal_page(stem: &'static str) -> Response {
    let dir = std::env::var("CC_REMOTE_LEGAL_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let body = legal_html(stem, dir.as_deref().map(Path::new));
    let mut res = Html(body).into_response();
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-cache".parse().expect("static header"),
    );
    res
}

/// Cap on a supplied page: a legal page is text, not a download.
const MAX_LEGAL_BYTES: u64 = 1 << 20;

fn legal_html(stem: &str, dir: Option<&Path>) -> String {
    if let Some(dir) = dir {
        let file = dir.join(format!("{stem}.html"));
        if std::fs::metadata(&file).is_ok_and(|m| m.is_file() && m.len() <= MAX_LEGAL_BYTES) {
            if let Ok(text) = std::fs::read_to_string(&file) {
                return text;
            }
        }
    }
    NEUTRAL_LEGAL.to_string()
}

/// No operator named, no address given: the notice only says who to ask.
const NEUTRAL_LEGAL: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hegai Code</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style></head><body>
<h1>Hegai Code</h1>
<p>This is a privately operated Hegai Code server. The operator of this server is responsible for the processing of your data, for support and for account deletion. Please contact your administrator.</p>
<hr lang="ru">
<p lang="ru">Это сервер Hegai Code, который эксплуатирует ваша организация. За обработку ваших данных, поддержку и удаление аккаунта отвечает оператор этого сервера. Обратитесь к вашему администратору.</p>
</body></html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_installers_are_untouched() {
        let s = "curl https://code.acme.test/go; wss://code.acme.test; code.acme.test/link";
        assert_eq!(localize_installer(s, "https://code.acme.test"), s);
        assert_eq!(localize_installer(s, "https://code.acme.test/"), s);
        assert_eq!(localize_installer(s, "https://CODE.acme.test"), s);
        assert_eq!(
            localize_installer(s, ""),
            s,
            "no public URL: leave it alone"
        );
        assert_eq!(localize_installer(s, "garbage"), s);
    }

    #[test]
    fn a_customer_hub_gets_its_own_name_in_all_three_spellings() {
        let s = "BASE=${HEGAI_URL:-https://code.acme.test}\nCENTRAL_URL=\"wss://code.acme.test\"\n# approve on code.acme.test/link";
        assert_eq!(
            localize_installer(s, "https://hub.acme.example"),
            "BASE=${HEGAI_URL:-https://hub.acme.example}\nCENTRAL_URL=\"wss://hub.acme.example\"\n# approve on hub.acme.example/link"
        );
        // A plain-http dev hub keeps its scheme and port; the socket becomes ws://.
        assert_eq!(
            localize_installer(s, "http://127.0.0.1:4319/"),
            "BASE=${HEGAI_URL:-http://127.0.0.1:4319}\nCENTRAL_URL=\"ws://127.0.0.1:4319\"\n# approve on 127.0.0.1:4319/link"
        );
    }

    #[test]
    fn every_embedded_installer_names_the_baked_host_only_in_known_spellings() {
        // If a script gains another spelling (a bare `code.acme.test:8443`, say),
        // the replacement above still covers it because the bare name is replaced
        // last; this pins that no installer carries the name in a form that would
        // survive localization.
        for script in [
            include_str!("../../deploy/go.sh"),
            include_str!("../../deploy/go.ps1"),
            include_str!("../../deploy/install-linux.sh"),
            include_str!("../../deploy/install-mac.sh"),
            include_str!("../../deploy/install-win.ps1"),
            include_str!("../../deploy/install-app-mac.sh"),
            include_str!("../../deploy/install-app-mac-shell.sh"),
            include_str!("../../deploy/install-app-win.ps1"),
            include_str!("../assets/codex-gateway.sh"),
            include_str!("../assets/codex-gateway.ps1"),
        ] {
            // Only lines tagged `vendor-literal` may keep the name, and only as
            // the vendor's origin or its /dl — never a spelling that would
            // point a customer's install at a host it does not own.
            let out = localize_installer(script, "https://hub.acme.example");
            for line in out.lines().filter(|l| l.contains(BAKED_HOST)) {
                assert!(
                    line.contains(VENDOR_LITERAL),
                    "unlocalized host on an untagged line: {line}"
                );
                assert!(
                    vendor_spellings_only(line),
                    "unknown spelling on a tagged line: {line}"
                );
            }
        }
    }

    /// Every occurrence of the baked host on `line` is exactly the vendor
    /// origin or its `/dl`, ending at a string delimiter — so
    /// `https://code.acme.test.attacker.example/dl` does not pass.
    fn vendor_spellings_only(line: &str) -> bool {
        line.match_indices(BAKED_HOST).all(|(i, _)| {
            let after = &line[i + BAKED_HOST.len()..];
            let after = after.strip_prefix("/dl").unwrap_or(after);
            line[..i].ends_with("https://")
                && matches!(
                    after.chars().next(),
                    None | Some('"' | '\'' | '}' | ' ' | ')')
                )
        })
    }

    #[test]
    fn the_app_download_base_is_a_plain_https_url_and_replaces_the_vendor_default() {
        assert_eq!(
            parse_app_download_base(" https://dl.example.com/app/ ").as_deref(),
            Some("https://dl.example.com/app")
        );
        assert_eq!(
            parse_app_download_base("https://code.example.com:8443/dl").as_deref(),
            Some("https://code.example.com:8443/dl")
        );
        for bad in [
            "",
            "http://dl.example.com",
            "https://",
            "https://x/$(id)",
            "https://x/a b",
            "https://x/\"q",
            "https://x/';rm",
            "https://x/`id`",
            "ftp://x",
            "https://dl.example.com:notaport/releases",
        ] {
            assert_eq!(parse_app_download_base(bad), None, "{bad:?}");
        }
        let script = include_str!("../../deploy/install-app-mac-shell.sh");
        let out = point_app_downloads(
            &localize_installer(script, "https://hub.acme.example"),
            "https://dl.example.com/app",
        );
        assert!(out.contains("${CC_APP_DL:-https://dl.example.com/app}"));
        assert!(!out.contains(&format!("https://{BAKED_HOST}/dl")));
        let ps = point_app_downloads(
            &localize_installer(
                include_str!("../../deploy/install-app-win.ps1"),
                "https://hub.acme.example",
            ),
            "https://dl.example.com/app",
        );
        assert!(ps.contains("'https://dl.example.com/app'"));
    }

    #[test]
    fn a_lookalike_vendor_host_is_not_a_vendor_spelling() {
        assert!(vendor_spellings_only(
            r#"DL="${CC_APP_DL:-https://code.acme.test/dl}" # vendor-literal"#
        ));
        assert!(vendor_spellings_only(
            "$dl = 'https://code.acme.test/dl' # vendor-literal"
        ));
        assert!(!vendor_spellings_only(
            r#"DL="https://code.acme.test.attacker.example/dl" # vendor-literal"#
        ));
        assert!(!vendor_spellings_only(
            r#"DL="https://code.acme.test/dlx" # vendor-literal"#
        ));
        assert!(!vendor_spellings_only(
            r#"DL="http://code.acme.test/dl" # vendor-literal"#
        ));
        assert!(!vendor_spellings_only(
            r#"DL="https://code.acme.test:8443/dl" # vendor-literal"#
        ));
    }

    #[test]
    fn a_vendor_literal_line_survives_localization_and_the_rest_follows_the_hub() {
        let s = "BASE=${B:-https://code.acme.test}\nDL=\"https://code.acme.test/dl\" # vendor-literal\nlast https://code.acme.test";
        assert_eq!(
            localize_installer(s, "https://hub.acme.example"),
            "BASE=${B:-https://hub.acme.example}\nDL=\"https://code.acme.test/dl\" # vendor-literal\nlast https://hub.acme.example"
        );
        // The vendor hub itself is untouched either way.
        assert_eq!(localize_installer(s, "https://code.acme.test"), s);
    }

    #[test]
    fn the_desktop_installers_download_from_the_vendor_and_pin_the_hub() {
        for (name, script) in [
            ("mac", include_str!("../../deploy/install-app-mac-shell.sh")),
            ("win", include_str!("../../deploy/install-app-win.ps1")),
        ] {
            let out = localize_installer(script, "https://hub.acme.example");
            assert!(
                out.contains("https://code.acme.test/dl"),
                "{name}: the vendor download was rewritten"
            );
            assert!(out.contains("CC_APP_DL"), "{name}: no download override");
            assert!(out.contains("hub-url"), "{name}: the hub is not remembered");
            assert!(
                out.contains("https://hub.acme.example"),
                "{name}: the hub default was not localized"
            );
            assert!(
                !out.contains("$BASE/dl") && !out.contains("$base/dl"),
                "{name}: downloads from the hub"
            );
        }
    }

    #[test]
    fn the_external_edition_refuses_a_short_fleet_token() {
        assert!(weak_external_token("dev-token", true).is_some());
        assert!(weak_external_token(&"a".repeat(31), true).is_some());
        assert!(weak_external_token(&"a".repeat(32), true).is_none());
        // The internal hub keeps whatever it has always accepted.
        assert!(weak_external_token("dev-token", false).is_none());
    }

    #[test]
    fn trusted_proxies_match_addresses_and_blocks() {
        let t =
            TrustedProxies::parse("172.18.0.0/16, 10.0.0.5 ,fd00::/8,bogus,300.1.1.1,1.2.3.4/40");
        assert_eq!(t.len(), 3);
        assert_eq!(
            TrustedProxies::rejected("172.18.0.0/16, bogus,,1.2.3.4/40"),
            vec!["bogus".to_string(), "1.2.3.4/40".to_string()]
        );
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(t.trusts(ip("172.18.0.3")));
        assert!(
            t.trusts(ip("::ffff:172.18.9.9")),
            "v4-mapped addresses are canonicalised"
        );
        assert!(!t.trusts(ip("172.19.0.3")));
        assert!(t.trusts(ip("10.0.0.5")));
        assert!(!t.trusts(ip("10.0.0.6")));
        assert!(t.trusts(ip("fd12::1")));
        assert!(!t.trusts(ip("fe80::1")));
        assert!(!t.trusts(ip("203.0.113.9")));
    }

    #[test]
    fn loopback_is_always_trusted_and_an_empty_list_trusts_nothing_else() {
        let t = TrustedProxies::parse("");
        assert!(t.trusts("127.0.0.1".parse().unwrap()));
        assert!(t.trusts("::1".parse().unwrap()));
        assert!(!t.trusts("172.18.0.3".parse().unwrap()));
        let all = TrustedProxies::parse("0.0.0.0/0");
        assert!(all.trusts("203.0.113.9".parse().unwrap()));
        assert!(
            !all.trusts("::2".parse().unwrap()),
            "a v4 block does not cover v6"
        );
    }

    #[test]
    fn legal_pages_prefer_the_operators_file_and_fall_back_to_a_neutral_notice() {
        let dir = std::env::temp_dir().join(format!("legal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("privacy.html"), "<p>Acme privacy</p>").unwrap();
        assert_eq!(legal_html("privacy", Some(&dir)), "<p>Acme privacy</p>");
        let neutral = legal_html("support", Some(&dir));
        assert!(neutral.contains("contact your administrator"));
        assert!(!neutral.contains("a.test") && !neutral.contains("ИП"));
        assert_eq!(legal_html("privacy", None), neutral);
        // Traversal is impossible by construction (fixed stems), and a directory is not a page.
        std::fs::create_dir_all(dir.join("support.html")).unwrap();
        assert_eq!(legal_html("support", Some(&dir)), neutral);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
