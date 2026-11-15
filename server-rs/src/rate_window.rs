//! Per-address rolling windows for the endpoints that are open to anyone:
//! «Подключить машину» (`/api/enrollments/*`) and «Войти через Telegram»
//! (`/api/auth/telegram/*`).
//!
//! Three properties, each the answer to a way it was abused on paper:
//! - an IPv6 client is counted by its /64 (`rate_ip`) — a VPS has 2^64
//!   addresses, and a per-address limit that counts each one is no limit;
//! - every key remembers its OWN window and is swept by it, so a key whose
//!   window is a minute does not sit in memory for a day;
//! - the map is bounded, and when it is full a NEW address is counted in a
//!   shared overflow bucket for that endpoint instead of being refused
//!   outright. A flood then costs that one endpoint a tighter budget for the
//!   length of its window — not every endpoint, for everyone, for a day.

use std::collections::HashMap;

/// Keys held before an ordinary (throttled) sweep runs.
const SWEEP_AT: usize = 4096;
/// The most keys ever held. Past it, new addresses share an overflow bucket.
const MAX_KEYS: usize = 65_536;
/// How much more the overflow bucket allows than one address — it stands in
/// for many people at once.
const OVERFLOW_FACTOR: usize = 8;

struct Entry {
    window_ms: i64,
    hits: Vec<i64>,
}

#[derive(Default)]
pub(crate) struct WindowLog {
    map: HashMap<String, Entry>,
    last_sweep: i64,
}

impl WindowLog {
    /// May `key` make one more request? `Ok` carries the key to `record`
    /// under (the overflow bucket when the map is full); `Err(())` is 429.
    pub(crate) fn check(
        &mut self,
        key: &str,
        limit: usize,
        window_ms: i64,
        now: i64,
    ) -> Result<String, ()> {
        if self.map.len() > SWEEP_AT && now - self.last_sweep > 60 * 1000 {
            self.sweep(now);
        }
        let (key, limit) = if self.map.contains_key(key) || self.map.len() < MAX_KEYS {
            (key.to_string(), limit)
        } else {
            // Full: try a sweep right away, then fall back to the bucket.
            self.sweep(now);
            if self.map.len() < MAX_KEYS {
                (key.to_string(), limit)
            } else {
                let prefix = key.split(':').next().unwrap_or(key);
                (
                    format!("{prefix}:overflow"),
                    limit.saturating_mul(OVERFLOW_FACTOR),
                )
            }
        };
        if let Some(entry) = self.map.get_mut(&key) {
            entry.hits.retain(|t| now - *t < window_ms);
            if entry.hits.len() >= limit {
                return Err(());
            }
        }
        Ok(key)
    }

    /// Count one request under the key `check` returned.
    pub(crate) fn record(&mut self, key: &str, window_ms: i64, now: i64) {
        let entry = self.map.entry(key.to_string()).or_insert_with(|| Entry {
            window_ms,
            hits: Vec::new(),
        });
        entry.window_ms = window_ms;
        entry.hits.push(now);
    }

    /// Drop every key with no hit inside its own window.
    fn sweep(&mut self, now: i64) {
        self.last_sweep = now;
        self.map
            .retain(|_, e| e.hits.iter().any(|t| now - *t < e.window_ms));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.len()
    }
}

/// The address a limit counts by: an IPv4 address as is, an IPv6 one as its
/// /64.
pub(crate) fn rate_ip(ip: Option<&str>) -> Option<String> {
    let ip = ip?;
    Some(match ip.parse::<std::net::Ipv6Addr>() {
        Ok(v6) if v6.to_ipv4_mapped().is_none() => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
        _ => ip.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60 * 1000;

    fn hit(log: &mut WindowLog, key: &str, limit: usize, window: i64, now: i64) -> bool {
        match log.check(key, limit, window, now) {
            Ok(k) => {
                log.record(&k, window, now);
                true
            }
            Err(()) => false,
        }
    }

    #[test]
    fn an_address_gets_its_limit_per_window_and_then_again() {
        let mut log = WindowLog::default();
        for _ in 0..3 {
            assert!(hit(&mut log, "p:1.2.3.4", 3, MIN, 0));
        }
        assert!(!hit(&mut log, "p:1.2.3.4", 3, MIN, 10));
        assert!(
            hit(&mut log, "p:5.6.7.8", 3, MIN, 10),
            "another address is not affected"
        );
        assert!(
            hit(&mut log, "p:1.2.3.4", 3, MIN, MIN + 1),
            "the window rolls"
        );
    }

    #[test]
    fn a_key_is_swept_by_its_own_window_not_by_a_day() {
        let mut log = WindowLog::default();
        for i in 0..(SWEEP_AT + 10) {
            hit(&mut log, &format!("poll:{i}"), 100, MIN, 0);
        }
        // Two minutes later every one-minute key is dead and goes.
        hit(&mut log, "poll:fresh", 100, MIN, 2 * MIN);
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn a_full_map_puts_new_addresses_in_a_shared_bucket_instead_of_refusing_all() {
        let mut log = WindowLog::default();
        for i in 0..MAX_KEYS {
            // Live keys with a long window: a sweep cannot free them.
            hit(&mut log, &format!("flood:{i}"), 100, 24 * 60 * MIN, 0);
        }
        // A newcomer to ANOTHER endpoint still gets in — through its bucket.
        assert!(hit(&mut log, "tg-start:203.0.113.7", 2, MIN, 1));
        assert!(log.len() <= MAX_KEYS + 1, "bounded");
        // The bucket is limited, just more generously than one address.
        let mut allowed = 1;
        while hit(
            &mut log,
            &format!("tg-start:198.51.100.{allowed}"),
            2,
            MIN,
            2,
        ) {
            allowed += 1;
        }
        assert_eq!(allowed, 2 * OVERFLOW_FACTOR);
    }

    #[test]
    fn ipv6_is_counted_by_its_64() {
        assert_eq!(rate_ip(Some("203.0.113.7")).as_deref(), Some("203.0.113.7"));
        assert_eq!(
            rate_ip(Some("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).as_deref(),
            Some("2001:db8:1:2::/64")
        );
        assert_eq!(
            rate_ip(Some("2001:db8:1:2::9")),
            rate_ip(Some("2001:db8:1:2:ffff::1"))
        );
        assert_eq!(
            rate_ip(Some("::ffff:1.2.3.4")).as_deref(),
            Some("::ffff:1.2.3.4")
        );
        assert_eq!(rate_ip(None), None);
    }
}
