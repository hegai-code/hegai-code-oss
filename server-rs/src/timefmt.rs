//! Minimal UTC time formatting and parsing — enough for the ISO-8601 stamps
//! on the provisioning wire (the provisioner `Date.parse`s `expiresAt`, and
//! `Date.parse` of a bare epoch number is `NaN`) and for the RFC 3339
//! `*_last_reset` timestamps Bifrost reports, without pulling chrono into the
//! hub for two call sites.

/// Days since 1970-01-01 → `(year, month, day)`. Howard Hinnant's
/// `civil_from_days`, valid for every date SQLite will ever hand us.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Epoch milliseconds → `2026-09-02T10:15:30.123Z`.
pub(crate) fn iso8601_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// RFC 3339 (`2026-09-02T10:15:30Z`, fractional seconds and `±HH:MM` offsets
/// accepted — the shapes Go's `time.Time` marshals to) → epoch milliseconds.
/// `None` for anything that does not parse; callers treat that as "unknown".
pub(crate) fn parse_rfc3339_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let (date, rest) = s.split_once(['T', 't', ' '])?;
    let mut dp = date.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let m: u32 = dp.next()?.parse().ok()?;
    let d: u32 = dp.next()?.parse().ok()?;
    if dp.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let tz_pos = rest.find(['Z', 'z', '+', '-'])?;
    let (time, tz) = rest.split_at(tz_pos);
    let (hms, frac) = match time.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (time, None),
    };
    let mut tp = hms.split(':');
    let h: i64 = tp.next()?.parse().ok()?;
    let mi: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next()?.parse().ok()?;
    if tp.next().is_some() || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let frac_ms = match frac {
        None => 0,
        Some(f) => {
            if f.is_empty() || !f.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let digits: String = f.chars().take(3).collect();
            let n: i64 = digits.parse().ok()?;
            n * 10_i64.pow(3 - digits.len() as u32)
        }
    };
    let offset_ms = match tz {
        "Z" | "z" => 0,
        _ => {
            let sign = if tz.starts_with('+') { 1 } else { -1 };
            let (oh, om) = tz[1..].split_once(':')?;
            let oh: i64 = oh.parse().ok()?;
            let om: i64 = om.parse().ok()?;
            sign * (oh * 3600 + om * 60) * 1000
        }
    };
    let days = days_from_civil(y, m, d);
    Some((days * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + frac_ms - offset_ms)
}

/// A Bifrost reset window (`1d`, `24h`, `30m`, `60s`, `1w`) → milliseconds.
pub(crate) fn parse_window_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let split = s.find(|c: char| !c.is_ascii_digit())?;
    let (num, unit) = s.split_at(split);
    let n: i64 = num.parse().ok()?;
    let unit_ms = match unit.trim() {
        "s" => 1000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        "w" => 7 * 86_400_000,
        _ => return None,
    };
    Some(n * unit_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_and_rfc3339_round_trip() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601_utc(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
        assert_eq!(
            parse_rfc3339_ms("2023-11-14T22:13:20Z"),
            Some(1_700_000_000_000)
        );
        assert_eq!(
            parse_rfc3339_ms("2023-11-14T22:13:20.5Z"),
            Some(1_700_000_000_500)
        );
        assert_eq!(
            parse_rfc3339_ms("2023-11-14T22:13:20.123456789Z"),
            Some(1_700_000_000_123)
        );
        // An offset shifts the instant, not the clock face.
        assert_eq!(
            parse_rfc3339_ms("2023-11-15T01:13:20+03:00"),
            Some(1_700_000_000_000)
        );
        assert_eq!(
            parse_rfc3339_ms("2023-11-14T19:13:20-03:00"),
            Some(1_700_000_000_000)
        );
        for ms in [1_i64, 951_782_400_000, 4_102_444_800_000, 1_756_809_330_123] {
            assert_eq!(parse_rfc3339_ms(&iso8601_utc(ms)), Some(ms), "{ms}");
        }
        assert!(parse_rfc3339_ms("").is_none());
        assert!(parse_rfc3339_ms("2023-13-01T00:00:00Z").is_none());
        assert!(parse_rfc3339_ms("1700000000000").is_none());
    }

    #[test]
    fn windows_parse_the_units_bifrost_uses() {
        assert_eq!(parse_window_ms("1d"), Some(86_400_000));
        assert_eq!(parse_window_ms("1h"), Some(3_600_000));
        assert_eq!(parse_window_ms("30m"), Some(1_800_000));
        assert_eq!(parse_window_ms(" 2w "), Some(14 * 86_400_000));
        assert!(parse_window_ms("1y").is_none());
        assert!(parse_window_ms("d").is_none());
        assert!(parse_window_ms("").is_none());
    }
}
