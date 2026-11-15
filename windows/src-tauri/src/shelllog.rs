//! The shell's own log file — `%LOCALAPPDATA%\Hegai Code\logs\shell.log`.
//!
//! Until 0.1.18 the shell had none. Every diagnostic in this crate is a
//! `println!`/`eprintln!` («[popup] …», «[hub] …»), and a release build on
//! Windows is a GUI-subsystem process (`windows_subsystem = "windows"`): there
//! is no console, so all of it went nowhere. When «Открыть в новом окне» froze
//! the app (27.09.2026) there was not one line to read — the cause had to be
//! found in wry's source instead.
//!
//! Three things, all cheap:
//!
//! 1. **Every `println!`/`eprintln!` lands here, stamped** — the crate's own
//!    macros shadow std's (top of main.rs). Not by pointing stdout at a pipe:
//!    that was tried first, and it depended on how the process was launched —
//!    the installer-started app on buildbox-pc logged nothing but its banner.
//! 2. **A panic is written synchronously.** `panic = "abort"` kills the process
//!    before a reader thread could drain the pipe, so the hook writes straight
//!    to the file first.
//! 3. **A watchdog for the main thread** (`watch_main_thread`). A hang is not an
//!    event anything reports — it is the absence of events. A background thread
//!    queues a no-op onto the event loop every two seconds and notes when it
//!    last ran; eight seconds without one is written down as a stall, with how
//!    long it lasted once it ends.
//!
//! Rotation is one generation: past 5 MB the file becomes `shell.log.1`, done
//! at startup by the primary instance only.

#[cfg(windows)]
use std::fs::{self, OpenOptions};
use std::fs::File;
use std::io::Write;
#[cfg(windows)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
const MAX_BYTES: u64 = 5 * 1024 * 1024;

static SINK: OnceLock<Mutex<File>> = OnceLock::new();

/// Where the log lives, whether or not it could be opened.
#[cfg(windows)]
pub fn path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    Some(base.join("Hegai Code").join("logs").join("shell.log"))
}

/// Write one stamped line, straight to the file. Safe to call before
/// `install` (it then does nothing) and from any thread.
pub fn line(msg: &str) {
    let Some(sink) = SINK.get() else { return };
    if let Ok(mut f) = sink.lock() {
        let _ = writeln!(f, "{} {}", stamp(now_ms()), msg.trim_end());
        let _ = f.flush();
    }
}

/// Open the file and route stdout/stderr and panics into it. Windows only —
/// on macOS a Finder-launched app's output is kept by the system log already.
pub fn install() {
    #[cfg(windows)]
    {
        let Some(path) = path() else { return };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        // Append only. Rotation and the «started» banner wait for `setup`
        // (`watch_main_thread`), which a second launch never reaches — the
        // single-instance plugin hands it over first. Rotating here let a
        // double-click rename the live instance's file out from under it.
        let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else { return };
        if SINK.set(Mutex::new(file)).is_err() {
            return;
        }
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            line(&format!("PANIC {info}"));
            default(info);
        }));
    }
}

static LAST_BEAT: AtomicU64 = AtomicU64::new(0);

/// Note, in the log, every stretch of eight seconds or more in which the event
/// loop did not run a queued task — see the module note.
pub fn watch_main_thread(app: tauri::AppHandle) {
    if SINK.get().is_none() {
        return;
    }
    rotate();
    line(&format!(
        "---- Hegai Code {} started (pid {}) ----",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    LAST_BEAT.store(now_ms(), Ordering::SeqCst);
    let _ = std::thread::Builder::new().name("main-watchdog".into()).spawn(move || {
        let mut stalled_since: Option<u64> = None;
        let mut last_tick = now_ms();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            // THIS thread overslept — the machine was asleep or the clock
            // jumped. That is not the main thread stalling, and a log kept
            // for hangs must not invent one on every lid close.
            let tick = now_ms();
            if tick.saturating_sub(last_tick) > 6_000 {
                LAST_BEAT.store(tick, Ordering::SeqCst);
                stalled_since = None;
                last_tick = tick;
                continue;
            }
            last_tick = tick;
            // From THIS thread `run_on_main_thread` queues rather than runs
            // inline (the trap `open_second_window` describes), which is the
            // whole point: the beat only moves if the loop is turning.
            let _ = app.run_on_main_thread(|| LAST_BEAT.store(now_ms(), Ordering::SeqCst));
            let now = now_ms();
            let beat = LAST_BEAT.load(Ordering::SeqCst);
            let silent = now.saturating_sub(beat);
            match stalled_since {
                None if silent >= 8_000 => {
                    stalled_since = Some(beat);
                    line(&format!("[watchdog] main thread not responding for {} s", silent / 1000));
                }
                Some(since) if silent < 4_000 => {
                    line(&format!(
                        "[watchdog] main thread back after {} s",
                        now.saturating_sub(since) / 1000
                    ));
                    stalled_since = None;
                }
                _ => {}
            }
        }
    });
}

/// One generation past 5 MB, in the primary instance only (see `install`),
/// reopening the sink under its lock so no line goes to the renamed file.
fn rotate() {
    #[cfg(windows)]
    {
        let Some(path) = path() else { return };
        if !fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            return;
        }
        let Some(sink) = SINK.get() else { return };
        let Ok(mut f) = sink.lock() else { return };
        if fs::rename(&path, path.with_extension("log.1")).is_ok() {
            if let Ok(fresh) = OpenOptions::new().create(true).append(true).open(&path) {
                *f = fresh;
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `2026-09-27 11:21:05.123Z` — UTC, so two machines' logs line up.
fn stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (y, mo, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{y:04}-{mo:02}-{d:02} {:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_utc_calendar_time() {
        assert_eq!(stamp(0), "1970-01-01 00:00:00.000Z");
        // 2026-09-27 09:21:05.123 UTC
        assert_eq!(stamp(1_790_500_865_123), "2026-09-27 09:21:05.123Z");
        assert_eq!(stamp(951_782_400_000), "2000-02-29 00:00:00.000Z");
    }
}
