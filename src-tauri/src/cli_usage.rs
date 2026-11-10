//! Claude quota via Claude Code's own `/usage` command.
//!
//! Runs `claude -p "/usage" --no-session-persistence --output-format json`.
//! `/usage` is a local command: it makes no model call (0 tokens, $0), and
//! `--no-session-persistence` keeps it out of the user's session history.
//! Claude Code fetches the numbers itself with its own sign-in, so this app
//! never touches the token. We parse lines such as:
//!
//! ```text
//! Current session: 10% used · resets Nov 11 at 12:40am (Asia/Singapore)
//! Current week (all models): 9% used · resets Nov 16 at 3pm (Asia/Singapore)
//! Current week (Fable): 0% used · resets Nov 16 at 3pm (Asia/Singapore)
//! ```

use crate::scan::QuotaWindow;
use chrono::{Datelike, Local, NaiveDate, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CliUsage {
    pub windows: Vec<QuotaWindow>,
    /// Unix ms of the last successful run.
    pub fetched_at: Option<i64>,
    /// "not_installed", "not_signed_in", "timeout", "parse_failed", ...
    pub error: Option<String>,
}

pub struct CliCache {
    last: Mutex<CliUsage>,
    last_run: Mutex<i64>,
    running: tauri::async_runtime::Mutex<()>,
    path: PathBuf,
}

/// Never run more often than this unless forced.
const MIN_INTERVAL_MS: i64 = 2 * 60_000;

impl CliCache {
    pub fn new(path: PathBuf) -> Self {
        let last = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<CliUsage>(&s).ok())
            .map(|mut u| {
                u.error = None;
                u
            })
            .unwrap_or_default();
        CliCache { last: Mutex::new(last), last_run: Mutex::new(0), running: tauri::async_runtime::Mutex::new(()), path }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Finds the `claude` executable. GUI apps don't get the shell's PATH, so we
/// check the usual install locations, then ask the login shell.
fn find_claude() -> Option<PathBuf> {
    crate::platform::claude_candidates().into_iter().find(|p| p.is_file()).or_else(crate::platform::which_claude)
}

pub async fn fetch(cache: &CliCache, force: bool) -> CliUsage {
    let _guard = cache.running.lock().await;
    {
        let last_run = *cache.last_run.lock().unwrap();
        if !force && now_ms() - last_run < MIN_INTERVAL_MS {
            return cache.last.lock().unwrap().clone();
        }
    }
    *cache.last_run.lock().unwrap() = now_ms();
    let result = tauri::async_runtime::spawn_blocking(run).await.unwrap_or_else(|e| Err(e.to_string()));
    let mut last = cache.last.lock().unwrap();
    match result {
        Ok(windows) => {
            *last = CliUsage { windows, fetched_at: Some(now_ms()), error: None };
            if let Some(dir) = cache.path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&cache.path, serde_json::to_vec(&*last).unwrap_or_default());
        }
        Err(e) => last.error = Some(e),
    }
    last.clone()
}

fn run() -> Result<Vec<QuotaWindow>, String> {
    let bin = find_claude().ok_or("not_installed")?;
    // A neutral working directory: no project settings or CLAUDE.md get loaded.
    let cwd = std::env::temp_dir();
    let mut child = crate::platform::command_for(&bin)
        .args(["-p", "/usage", "--no-session-persistence", "--output-format", "json", "--strict-mcp-config"])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "not_installed".to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() > deadline => {
                let _ = child.kill();
                return Err("timeout".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| "bad_output".to_string())?;
    let text = v["result"].as_str().unwrap_or_default();
    if v["is_error"].as_bool() == Some(true) {
        let low = text.to_lowercase();
        return Err(if low.contains("log in") || low.contains("login") || low.contains("auth") { "not_signed_in" } else { "cli_error" }.into());
    }
    let windows = parse(text, Local::now().naive_local());
    if windows.is_empty() {
        let low = text.to_lowercase();
        return Err(if low.contains("api key") || low.contains("subscription") && !low.contains("using your subscription") {
            "no_subscription"
        } else {
            "parse_failed"
        }
        .into());
    }
    Ok(windows)
}

/// Parses the `/usage` text. `now` (local) picks the year of reset dates.
pub fn parse(text: &str, now: chrono::NaiveDateTime) -> Vec<QuotaWindow> {
    let re = regex::Regex::new(r"(?m)^\s*Current (session|week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$").unwrap();
    let mut out = Vec::new();
    for c in re.captures_iter(text) {
        let used: f64 = c[3].parse().unwrap_or(0.0);
        let (key, minutes) = if &c[1] == "session" {
            ("five_hour".to_string(), 300)
        } else {
            match c.get(2).map(|m| m.as_str().trim()) {
                None | Some("all models") => ("seven_day".to_string(), 10080),
                Some(model) => (format!("seven_day_{}", model.to_lowercase().replace(|ch: char| !ch.is_ascii_alphanumeric(), "_")), 10080),
            }
        };
        if out.iter().any(|w: &QuotaWindow| w.key == key) {
            continue;
        }
        let resets_at = c.get(4).and_then(|m| parse_reset(m.as_str(), now));
        out.push(QuotaWindow { key, used_percent: used, resets_at, window_minutes: Some(minutes) });
    }
    out
}

/// "Nov 11 at 12:40am (Asia/Singapore)", "3pm (Asia/Singapore)" → unix seconds.
/// The time is in the system time zone (Claude Code formats it that way).
fn parse_reset(s: &str, now: chrono::NaiveDateTime) -> Option<i64> {
    let s = s.split('(').next()?.trim();
    let (date_part, time_part) = match s.split_once(" at ") {
        Some((d, t)) => (Some(d.trim()), t.trim()),
        None if s.chars().next()?.is_ascii_digit() => (None, s),
        None => (Some(s), "12am"),
    };
    let time = parse_time(time_part)?;
    let date = match date_part {
        Some(d) => {
            let mut it = d.split_whitespace();
            let mon = month(it.next()?)?;
            let day: u32 = it.next()?.trim_end_matches(',').parse().ok()?;
            let mut date = NaiveDate::from_ymd_opt(now.year(), mon, day)?;
            // A date well in the past means next year (e.g. "Jan 2" seen in December).
            if date < now.date() - chrono::Duration::days(30) {
                date = NaiveDate::from_ymd_opt(now.year() + 1, mon, day)?;
            }
            date
        }
        None => {
            let today = now.date();
            if today.and_time(time) < now { today.succ_opt()? } else { today }
        }
    };
    Local.from_local_datetime(&date.and_time(time)).earliest().map(|d| d.timestamp())
}

fn parse_time(t: &str) -> Option<NaiveTime> {
    let t = t.to_lowercase().replace(' ', "");
    let (num, pm) = if let Some(n) = t.strip_suffix("am") {
        (n.to_string(), false)
    } else if let Some(n) = t.strip_suffix("pm") {
        (n.to_string(), true)
    } else {
        let (h, m) = t.split_once(':')?;
        return NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0);
    };
    let (h, m) = match num.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (num.parse::<u32>().ok()?, 0),
    };
    let h = (h % 12) + if pm { 12 } else { 0 };
    NaiveTime::from_hms_opt(h, m, 0)
}

fn month(m: &str) -> Option<u32> {
    let names = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let m = m.to_lowercase();
    names.iter().position(|n| m.starts_with(n)).map(|i| i as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_text() {
        let text = "You are currently using your subscription to power your Claude Code usage\n\n\
Current session: 10% used · resets Nov 11 at 12:40am (Asia/Singapore)\n\
Current week (all models): 9% used · resets Nov 16 at 3pm (Asia/Singapore)\n\
Current week (Fable): 0% used · resets Nov 16 at 3pm (Asia/Singapore)\n\nWhat's contributing...";
        let now = NaiveDate::from_ymd_opt(2026, 11, 10).unwrap().and_hms_opt(20, 0, 0).unwrap();
        let w = parse(text, now);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].key, "five_hour");
        assert_eq!(w[0].used_percent, 10.0);
        assert_eq!(w[1].key, "seven_day");
        assert_eq!(w[2].key, "seven_day_fable");
        let r0 = Local.timestamp_opt(w[0].resets_at.unwrap(), 0).unwrap().naive_local();
        assert_eq!(r0.to_string(), "2026-11-11 00:40:00");
        let r1 = Local.timestamp_opt(w[1].resets_at.unwrap(), 0).unwrap().naive_local();
        assert_eq!(r1.to_string(), "2026-11-16 15:00:00");
    }

    #[test]
    fn year_rollover_and_time_only() {
        let now = NaiveDate::from_ymd_opt(2026, 12, 30).unwrap().and_hms_opt(22, 0, 0).unwrap();
        let w = parse("Current week (all models): 50% used · resets Jan 2 at 9am (UTC)\nCurrent session: 1% used · resets 3am (UTC)", now);
        let r = |i: usize| Local.timestamp_opt(w[i].resets_at.unwrap(), 0).unwrap().naive_local().to_string();
        assert_eq!(r(0), "2027-01-02 09:00:00");
        assert_eq!(r(1), "2026-12-31 03:00:00");
    }

    #[test]
    #[ignore]
    fn live_run() {
        println!("{:?}", run());
    }
}
