#![allow(dead_code)] // consumed by the external-edition login, rollout and support modules
//! Which product this hub is: the internal Hegai Code (code.acme.test) or the
//! external, self-hosted edition a customer runs on their own server.
//!
//! The two share every line of code. What differs is policy, and every policy
//! that differs reads it from HERE rather than from its own env var, so that
//! "is this the customer's hub?" has exactly one answer:
//!
//! | | internal (default) | external |
//! |---|---|---|
//! | agent rollout | a hub deploy is the rollout | a new bundle waits for the owner's approval (with their authenticator code) and must carry our release signature |
//! | new accounts | community gate (`CC_REMOTE_ACCESS_DEFAULT`) | active only when vouched for (owner-created, bootstrap owner, listed OIDC/Google domain); everyone else waits for the owner's approval |
//! | HegAI defaults | llm.acme.test, admin.acme.test SSO | none: a feature without its env var is off |
//!
//! `CC_REMOTE_EDITION=external` selects the external edition. Anything else,
//! including unset, is internal — so code.acme.test keeps behaving exactly as
//! it did before this switch existed.

use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    Internal,
    External,
}

impl Edition {
    pub fn parse(raw: Option<&str>) -> Edition {
        match raw.map(str::trim) {
            Some(v) if v.eq_ignore_ascii_case("external") => Edition::External,
            _ => Edition::Internal,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Edition::Internal => "internal",
            Edition::External => "external",
        }
    }
}

static EDITION: OnceLock<Edition> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static TEST_EDITION: std::cell::Cell<Option<Edition>> = const { std::cell::Cell::new(None) };
}

/// Run `f` on this thread as if the hub were `edition` (tests only: the real
/// value is a process-wide `OnceLock`, which one test cannot flip for another).
#[cfg(test)]
pub fn with_edition<R>(edition: Edition, f: impl FnOnce() -> R) -> R {
    let before = TEST_EDITION.with(|e| e.replace(Some(edition)));
    let out = f();
    TEST_EDITION.with(|e| e.set(before));
    out
}

/// The edition of this process, read once from `CC_REMOTE_EDITION`.
pub fn current() -> Edition {
    #[cfg(test)]
    if let Some(e) = TEST_EDITION.with(|e| e.get()) {
        return e;
    }
    *EDITION.get_or_init(|| Edition::parse(std::env::var("CC_REMOTE_EDITION").ok().as_deref()))
}

pub fn is_external() -> bool {
    current() == Edition::External
}

/// A HegAI-specific default (a URL on acme.test) — kept for the internal hub,
/// empty for the external one, where an unset feature is simply off.
pub fn hegai_default(internal: &str) -> String {
    if is_external() {
        String::new()
    } else {
        internal.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_word_external_selects_external() {
        assert_eq!(Edition::parse(None), Edition::Internal);
        assert_eq!(Edition::parse(Some("")), Edition::Internal);
        assert_eq!(Edition::parse(Some("internal")), Edition::Internal);
        assert_eq!(Edition::parse(Some("extern")), Edition::Internal);
        assert_eq!(Edition::parse(Some("external")), Edition::External);
        assert_eq!(Edition::parse(Some(" EXTERNAL ")), Edition::External);
    }
}
