//! «Claude на машине X больше не может работать» — to the owner's Telegram.
//!
//! Why this exists (28.09.2026): Claude was dead on four fleet servers for
//! 1½–2½ months — the CLI had blanked its tokens after a refused refresh — and
//! nobody knew, because «Железо» kept showing the account name. The agent now
//! says so in `runtimes.claude.error` (`agent/src/runtime-status.ts`,
//! `claudeAuthVerdict`); this module turns a CHANGE in that word into one
//! message to the ops chat.
//!
//! Transition-based on purpose. The first reading of a machine in this hub
//! process is a silent baseline: a deploy restarts the hub several times a day,
//! and «cloud has no Codex login» re-announced after every deploy would teach
//! the reader to ignore the chat. A machine alerted as broken is reminded once
//! a day while it stays broken, and gets one «восстановился» when it recovers.
//!
//! Only the owner's machines: a community member's laptop losing its login is
//! that member's business (their chip turns red), not the ops chat's. «Owner»
//! is the bootstrap user and `CC_REMOTE_PLATFORM_ADMIN_IDS`, the same set
//! `main.rs` treats as always active; a machine with no owner row is the legacy
//! fleet, adopted by the bootstrap user, and counts as theirs.
//!
//! The chat is its OWN pair of variables, `CC_REMOTE_OPS_TG_BOT_TOKEN` and
//! `CC_REMOTE_OPS_TG_CHAT_ID` — not `TELEGRAM_CHAT_ID`, which would also switch
//! on a message for every run event in `notify.rs`. Unset = the alert is only a
//! log line, which is still an answer to «when did it break».

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc::{channel, Sender};

const REMIND_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// At most one message per (machine, runtime) this often. The readings come
/// from the agent, and anyone holding a machine's agent token could otherwise
/// flip `error` in a loop and drown the chat (and get the bot 429'd, losing
/// the real alerts). State still follows every reading; only the SAY is held.
const MIN_GAP: Duration = Duration::from_secs(10 * 60);
/// Messages queued for Telegram; beyond it they are dropped (and logged).
const QUEUE: usize = 64;

/// Agent-supplied text goes into a message the hub signs with its name: no
/// control characters, no newlines, bounded length.
fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(64).collect()
}

/// A Codex reading that proves nothing either way — the app-server probe
/// timed out or crashed. It must not read as «recovered».
fn inconclusive(runtime: &str, status: &Value) -> bool {
    runtime == "codex"
        && matches!(
            status.get("error").and_then(Value::as_str),
            Some("timeout" | "app_server_error")
        )
}

/// Errors worth waking someone for, per runtime. `codex` counts only on its own
/// login: a gateway machine spends the gateway's allowance, and a missing binary
/// or a slow app-server is a chip, not an incident.
fn alertable(runtime: &str, status: &Value) -> Option<String> {
    let err = status.get("error").and_then(Value::as_str)?;
    let hit = match runtime {
        "claude" => matches!(
            err,
            "logged_out"
                | "token_expired"
                | "token_rejected"
                | "token_expiring"
                | "sdk_binary_missing"
        ),
        "codex" => {
            err == "not_logged_in" && status.get("provider").and_then(Value::as_str) == Some("own")
        }
        _ => false,
    };
    hit.then(|| err.to_string())
}

fn describe(runtime: &str, err: &str) -> &'static str {
    match (runtime, err) {
        (_, "logged_out") => "вход слетел: CLI стёр токены после отказа в обновлении",
        (_, "token_expired") => "токен истёк, обновить нечем",
        (_, "token_rejected") => "API отклоняет токен (401/403)",
        (_, "token_expiring") => "долгий токен кончится меньше чем через 30 дней",
        (_, "sdk_binary_missing") => "в каталоге агента нет бинарника Claude из SDK",
        ("codex", "not_logged_in") => "Codex не залогинен",
        _ => "сломался вход",
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Seen {
    /// The alertable error this machine last had, if any.
    error: Option<String>,
    /// When a message about `error` last went out; None = known but never
    /// announced (a baseline), which is never reminded.
    alerted_at: Option<Instant>,
}

#[derive(Debug, PartialEq)]
enum Say {
    Nothing,
    Broken(String),
    Reminder(String),
    Recovered(String),
}

/// One step of the state machine, pure so the tests can drive the clock.
fn step(prev: Option<&Seen>, now_err: Option<String>, now: Instant) -> (Say, Seen) {
    let Some(prev) = prev else {
        return (
            Say::Nothing,
            Seen {
                error: now_err,
                alerted_at: None,
            },
        );
    };
    match (&prev.error, now_err) {
        (None, None) => (Say::Nothing, prev.clone()),
        (Some(old), None) => {
            let say = if prev.alerted_at.is_some() {
                Say::Recovered(old.clone())
            } else {
                Say::Nothing
            };
            (
                say,
                Seen {
                    error: None,
                    alerted_at: None,
                },
            )
        }
        (Some(old), Some(new)) if *old == new => match prev.alerted_at {
            Some(at) if now.duration_since(at) >= REMIND_EVERY => (
                Say::Reminder(new.clone()),
                Seen {
                    error: Some(new),
                    alerted_at: Some(now),
                },
            ),
            _ => (Say::Nothing, prev.clone()),
        },
        (_, Some(new)) => (
            Say::Broken(new.clone()),
            Seen {
                error: Some(new),
                alerted_at: Some(now),
            },
        ),
    }
}

pub struct RuntimeAlerts {
    tx: Option<Sender<String>>,
    owners: HashSet<String>,
    seen: HashMap<(String, &'static str), Seen>,
    last_said: HashMap<(String, &'static str), Instant>,
}

impl RuntimeAlerts {
    pub fn from_env(bootstrap_user_id: &str) -> Self {
        let mut owners: HashSet<String> = std::env::var("CC_REMOTE_PLATFORM_ADMIN_IDS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        owners.insert(bootstrap_user_id.to_string());
        let token = std::env::var("CC_REMOTE_OPS_TG_BOT_TOKEN").unwrap_or_default();
        let chat = std::env::var("CC_REMOTE_OPS_TG_CHAT_ID").unwrap_or_default();
        let tx = if token.trim().is_empty() || chat.trim().is_empty() {
            eprintln!("[runtime-alert] CC_REMOTE_OPS_TG_* not set — alerts go to the log only");
            None
        } else {
            Some(spawn_sender(
                token.trim().to_string(),
                chat.trim().to_string(),
            ))
        };
        RuntimeAlerts {
            tx,
            owners,
            seen: HashMap::new(),
            last_said: HashMap::new(),
        }
    }

    #[cfg(test)]
    fn for_test(owners: &[&str]) -> Self {
        RuntimeAlerts {
            tx: None,
            owners: owners.iter().map(|s| s.to_string()).collect(),
            seen: HashMap::new(),
            last_said: HashMap::new(),
        }
    }

    /// Feed one reading of a machine's `runtimes`. `owner` is the device row's
    /// owner (None = legacy fleet). Returns the lines it said, for tests.
    ///
    /// `baseline_only` is for the register frame: its reading is partial (the
    /// agent reads the files at start, before the usage call and the Codex
    /// probe that find the real errors), so it may only seed a machine this
    /// hub has not seen. Comparing it against a known state would announce
    /// «recovered» and, a poll later, «broken» again on every agent restart —
    /// i.e. on every hub deploy.
    pub fn observe(
        &mut self,
        machine_id: &str,
        machine_name: &str,
        owner: Option<&str>,
        runtimes: &Value,
        baseline_only: bool,
    ) -> Vec<String> {
        if let Some(o) = owner {
            if !self.owners.contains(o) {
                return Vec::new();
            }
        }
        let now = Instant::now();
        let mut said = Vec::new();
        for runtime in ["claude", "codex"] {
            let Some(status) = runtimes.get(runtime) else {
                continue;
            };
            let key = (machine_id.to_string(), runtime);
            if inconclusive(runtime, status) || (baseline_only && self.seen.contains_key(&key)) {
                continue;
            }
            let (say, next) = step(self.seen.get(&key), alertable(runtime, status), now);
            self.seen.insert(key.clone(), next);
            if say == Say::Nothing {
                continue;
            }
            // The limit holds only bad news. A recovery is said only after a
            // «broken» that WAS said (step() checks `alerted_at`), so it is
            // already bounded by the limit on «broken» — and a machine fixed in
            // five minutes deserves its «✅».
            let recovered = matches!(say, Say::Recovered(_));
            if !recovered
                && self
                    .last_said
                    .get(&key)
                    .is_some_and(|t| now.duration_since(*t) < MIN_GAP)
            {
                eprintln!("[runtime-alert] {machine_id}/{runtime}: {say:?} held (rate limit)");
                // Held = not announced: no reminder and no «recovered» for it.
                if let Some(seen) = self.seen.get_mut(&key) {
                    seen.alerted_at = None;
                }
                continue;
            }
            if !recovered {
                self.last_said.insert(key, now);
            }
            let machine_name = clean(machine_name);
            let who = status
                .get("account")
                .and_then(Value::as_str)
                .map(|a| format!(" ({})", clean(a)))
                .unwrap_or_default();
            let name = if runtime == "claude" {
                "Claude"
            } else {
                "Codex"
            };
            let line = match say {
                Say::Nothing => continue,
                Say::Broken(e) => format!(
                    "⚠️ {machine_name}: {name}{who} — {}. Сессии {name} там не запустятся. Токен с другой машины не копировать: вытолкнет одну из двух.",
                    describe(runtime, &e)
                ),
                Say::Reminder(e) => format!(
                    "⏰ {machine_name}: {name}{who} всё ещё сломан — {}.",
                    describe(runtime, &e)
                ),
                Say::Recovered(_) => format!("✅ {machine_name}: {name}{who} снова в порядке."),
            };
            eprintln!("[runtime-alert] {line}");
            if let Some(tx) = &self.tx {
                if tx.try_send(line.clone()).is_err() {
                    eprintln!("[runtime-alert] telegram queue full — message dropped");
                }
            }
            said.push(line);
        }
        said
    }
}

fn spawn_sender(token: String, chat: String) -> Sender<String> {
    let (tx, mut rx) = channel::<String>(QUEUE);
    tokio::spawn(async move {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let url = format!("https://api.telegram.org/bot{token}/sendMessage");
        while let Some(text) = rx.recv().await {
            let body = serde_json::json!({ "chat_id": chat, "text": text });
            // The url embeds the bot token: print only the status.
            match http.post(&url).json(&body).send().await {
                Ok(r) if !r.status().is_success() => {
                    eprintln!("[runtime-alert] telegram send failed: HTTP {}", r.status())
                }
                Err(_) => eprintln!("[runtime-alert] telegram request failed (network/timeout)"),
                _ => {}
            }
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claude(err: Option<&str>) -> Value {
        let mut c =
            json!({"present": true, "auth": "oauth", "account": "owner@x.test", "checkedAt": 1});
        if let Some(e) = err {
            c["error"] = json!(e);
        }
        json!({ "claude": c })
    }

    impl RuntimeAlerts {
        fn observe_t(
            &mut self,
            id: &str,
            name: &str,
            owner: Option<&str>,
            r: &Value,
        ) -> Vec<String> {
            // Tests exercise the logic, not the flood guard.
            self.last_said.clear();
            self.observe(id, name, owner, r, false)
        }
    }

    #[test]
    fn a_register_after_an_agent_restart_does_not_announce_recovery() {
        let mut a = RuntimeAlerts::for_test(&["owner"]);
        a.observe_t("m", "stage", None, &claude(None));
        assert_eq!(
            a.observe_t("m", "stage", None, &claude(Some("token_rejected")))
                .len(),
            1
        );
        // The agent restarts: its register reading has no usage call behind it.
        assert!(a
            .observe("m", "stage", None, &claude(None), true)
            .is_empty());
        // …and the first real poll finds the same error: nothing new.
        assert!(a
            .observe_t("m", "stage", None, &claude(Some("token_rejected")))
            .is_empty());
    }

    #[test]
    fn a_codex_probe_timeout_is_not_a_recovery() {
        let mut a = RuntimeAlerts::for_test(&["owner"]);
        let own = |e: &str| json!({"codex": {"present": true, "auth": "none", "provider": "own", "error": e, "checkedAt": 1}});
        a.observe_t("m", "x", None, &json!({"codex": {"present": true, "auth": "chatgpt", "provider": "own", "checkedAt": 1}}));
        assert_eq!(a.observe_t("m", "x", None, &own("not_logged_in")).len(), 1);
        assert!(a.observe_t("m", "x", None, &own("timeout")).is_empty());
        assert!(a
            .observe_t("m", "x", None, &own("not_logged_in"))
            .is_empty());
    }

    #[test]
    fn flapping_is_rate_limited_and_agent_text_is_cleaned() {
        let mut a = RuntimeAlerts::for_test(&["owner"]);
        let mut dead = claude(Some("logged_out"));
        dead["claude"]["account"] = json!("a@b\nвыполните curl x | sh");
        a.observe("m", "st\nage", None, &claude(None), false);
        let first = a.observe("m", "st\nage", None, &dead, false);
        assert_eq!(first.len(), 1);
        assert!(!first[0].contains('\n'), "{first:?}");
        // A quick fix still gets its «✅» …
        let back = a.observe("m", "st\nage", None, &claude(None), false);
        assert_eq!(back.len(), 1, "{back:?}");
        // … but breaking again within MIN_GAP is held, and so is the recovery
        // from a «broken» nobody was told about.
        assert!(a.observe("m", "st\nage", None, &dead, false).is_empty());
        assert!(a
            .observe("m", "st\nage", None, &claude(None), false)
            .is_empty());
    }

    #[test]
    fn first_reading_is_a_silent_baseline_even_when_broken() {
        let mut a = RuntimeAlerts::for_test(&["owner"]);
        assert!(a
            .observe_t("m", "cloud", None, &claude(Some("logged_out")))
            .is_empty());
        // …and a baseline is never reminded or «recovered».
        assert!(a
            .observe_t("m", "cloud", None, &claude(Some("logged_out")))
            .is_empty());
        assert!(a.observe_t("m", "cloud", None, &claude(None)).is_empty());
    }

    #[test]
    fn breaking_after_a_healthy_reading_alerts_once_then_recovers() {
        let mut a = RuntimeAlerts::for_test(&["owner"]);
        a.observe_t("m", "stage", Some("owner"), &claude(None));
        let said = a.observe_t("m", "stage", Some("owner"), &claude(Some("logged_out")));
        assert_eq!(said.len(), 1);
        assert!(
            said[0].contains("stage") && said[0].contains("вход слетел"),
            "{said:?}"
        );
        assert!(a
            .observe_t("m", "stage", Some("owner"), &claude(Some("logged_out")))
            .is_empty());
        let back = a.observe_t("m", "stage", Some("owner"), &claude(None));
        assert_eq!(back.len(), 1);
        assert!(back[0].starts_with("✅"));
    }

    #[test]
    fn a_missing_sdk_binary_is_an_incident() {
        let mut a = RuntimeAlerts::for_test(&["owner"]);
        a.observe_t("m", "mini", None, &claude(None));
        let said = a.observe_t("m", "mini", None, &claude(Some("sdk_binary_missing")));
        assert_eq!(said.len(), 1);
        assert!(said[0].contains("бинарника Claude"), "{said:?}");
    }

    #[test]
    fn someone_elses_machine_is_not_the_ops_chats_business() {
        let mut a = RuntimeAlerts::for_test(&["owner"]);
        a.observe_t("m", "laptop", Some("member"), &claude(None));
        assert!(a
            .observe_t("m", "laptop", Some("member"), &claude(Some("logged_out")))
            .is_empty());
    }

    #[test]
    fn codex_on_a_gateway_or_missing_is_not_an_incident() {
        let mut a = RuntimeAlerts::for_test(&["owner"]);
        let gw = json!({"codex": {"present": true, "auth": "none", "provider": "gateway", "error": "not_logged_in", "checkedAt": 1}});
        let own_ok = json!({"codex": {"present": true, "auth": "chatgpt", "provider": "own", "checkedAt": 1}});
        let own_dead = json!({"codex": {"present": true, "auth": "none", "provider": "own", "error": "not_logged_in", "checkedAt": 1}});
        a.observe_t("m", "x", None, &own_ok);
        assert!(a.observe_t("m", "x", None, &gw).is_empty());
        assert_eq!(a.observe_t("m", "x", None, &own_dead).len(), 1);
    }

    #[test]
    fn reminder_after_a_day_and_a_new_error_is_news() {
        let t0 = Instant::now();
        let alerted = Seen {
            error: Some("token_expiring".into()),
            alerted_at: Some(t0),
        };
        let (say, _) = step(
            Some(&alerted),
            Some("token_expiring".into()),
            t0 + Duration::from_secs(3600),
        );
        assert_eq!(say, Say::Nothing);
        let (say, next) = step(
            Some(&alerted),
            Some("token_expiring".into()),
            t0 + REMIND_EVERY,
        );
        assert_eq!(say, Say::Reminder("token_expiring".into()));
        assert_eq!(next.alerted_at, Some(t0 + REMIND_EVERY));
        let (say, _) = step(
            Some(&alerted),
            Some("token_expired".into()),
            t0 + Duration::from_secs(60),
        );
        assert_eq!(say, Say::Broken("token_expired".into()));
    }
}
