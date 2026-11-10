//! Official Claude quota data via Claude Code's status line.
//!
//! Claude Code pipes a JSON object to the configured `statusLine` command on
//! every status refresh. For subscribers it includes
//! `rate_limits.five_hour` / `rate_limits.seven_day` with `used_percentage`
//! and `resets_at`. When the user clicks "Connect", we:
//!
//! 1. write a tiny POSIX shell script to `~/.claude/usage-float/statusline.sh`
//!    that saves that JSON to `~/.claude/usage-float/status.json` and prints a
//!    short status line (or runs the user's previous status line command, so
//!    an existing status line keeps working);
//! 2. back up `~/.claude/settings.json` and point `statusLine` at the script.
//!
//! "Disconnect" restores the previous `statusLine` value exactly.
//! The status line only runs in Claude Code's terminal / IDE interface.

use crate::scan::QuotaWindow;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

fn claude_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude")
}
fn bridge_dir() -> PathBuf {
    claude_dir().join("usage-float")
}
fn settings_path() -> PathBuf {
    claude_dir().join("settings.json")
}
fn script_path() -> PathBuf {
    bridge_dir().join("statusline.sh")
}
fn data_path() -> PathBuf {
    bridge_dir().join("status.json")
}
/// Holds the user's previous `statusLine` value (or null) for disconnecting.
fn previous_path() -> PathBuf {
    bridge_dir().join("previous-statusline.json")
}

const SCRIPT: &str = r#"#!/bin/sh
# Written by Usage Float. Saves Claude Code's status line input so the
# Usage Float widget can show your Claude quota. Safe to delete; use
# "Disconnect" in Usage Float to restore your previous status line.
dir="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
printf '%s' "$input" > "$dir/status.json.tmp" && mv -f "$dir/status.json.tmp" "$dir/status.json"
if [ -f "$dir/previous-command" ]; then
  printf '%s' "$input" | sh "$dir/previous-command"
  exit 0
fi
pct() { printf '%s' "$input" | tr -d '\n' | sed -n "s/.*\"$1\"[^}]*\"used_percentage\"[^0-9]*\([0-9.]*\).*/\1/p" | cut -d. -f1; }
five=$(pct five_hour); week=$(pct seven_day)
out=""
[ -n "$five" ] && out="5h $((100 - five))% left"
[ -n "$week" ] && out="${out:+$out · }week $((100 - week))% left"
printf '%s' "${out:-Usage Float}"
"#;

#[derive(Serialize)]
pub struct StatuslineState {
    /// Our script is the configured status line.
    pub connected: bool,
    /// Another status line command is configured (we would wrap it).
    pub has_other: bool,
    pub windows: Vec<QuotaWindow>,
    /// Unix ms when Claude Code last wrote data.
    pub observed_at: Option<i64>,
}

fn read_settings() -> Result<Value, String> {
    match std::fs::read_to_string(settings_path()) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|_| "settings_invalid".to_string()),
        _ => Ok(json!({})),
    }
}

fn write_settings(v: &Value) -> Result<(), String> {
    let path = settings_path();
    let tmp = path.with_extension("json.usage-float.tmp");
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn our_command() -> String {
    // Claude Code runs status lines with sh (Git Bash on Windows), which
    // takes forward slashes on every platform.
    format!("sh \"{}\"", script_path().display().to_string().replace('\\', "/"))
}

fn is_ours(v: &Value) -> bool {
    v.get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(|c| c.as_str())
        .is_some_and(|c| c.contains("usage-float/statusline.sh"))
}

fn parse_windows(input: &Value) -> Vec<QuotaWindow> {
    let mut out = Vec::new();
    let Some(rl) = input.get("rate_limits").and_then(|r| r.as_object()) else { return out };
    for (key, w) in rl {
        let Some(used) = w.get("used_percentage").and_then(|x| x.as_f64()) else { continue };
        // Accept seconds, milliseconds or an ISO string.
        let resets_at = match w.get("resets_at") {
            Some(Value::Number(n)) => n.as_f64().map(|x| if x > 1e12 { (x / 1000.0) as i64 } else { x as i64 }),
            Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp()),
            _ => None,
        };
        let window_minutes = if key == "five_hour" { Some(300) } else if key.starts_with("seven_day") { Some(10080) } else { None };
        out.push(QuotaWindow { key: key.clone(), used_percent: used, resets_at, window_minutes });
    }
    out.sort_by_key(|w| (w.key != "five_hour", w.key != "seven_day", w.key.clone()));
    out
}

pub fn state() -> StatuslineState {
    let settings = read_settings().unwrap_or(json!({}));
    let connected = is_ours(&settings);
    let has_other = !connected && settings.get("statusLine").is_some_and(|s| !s.is_null());
    let (mut windows, mut observed_at) = (Vec::new(), None);
    if let Ok(text) = std::fs::read_to_string(data_path()) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            windows = parse_windows(&v);
            observed_at = std::fs::metadata(data_path())
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
        }
    }
    StatuslineState { connected, has_other, windows, observed_at }
}

pub fn connect() -> Result<StatuslineState, String> {
    let mut settings = read_settings()?;
    if is_ours(&settings) {
        return Ok(state());
    }
    std::fs::create_dir_all(bridge_dir()).map_err(|e| e.to_string())?;
    // Back up settings.json once, before our first change.
    let backup = claude_dir().join("settings.json.usage-float.bak");
    if settings_path().exists() && !backup.exists() {
        std::fs::copy(settings_path(), &backup).map_err(|e| e.to_string())?;
    }
    let previous = settings.get("statusLine").cloned().unwrap_or(Value::Null);
    std::fs::write(previous_path(), serde_json::to_vec_pretty(&previous).unwrap_or_default()).map_err(|e| e.to_string())?;
    // Keep an existing status line visible by running it from our script.
    let prev_cmd = previous.get("command").and_then(|c| c.as_str()).filter(|c| !c.trim().is_empty());
    let prev_file = bridge_dir().join("previous-command");
    match prev_cmd {
        Some(cmd) => std::fs::write(&prev_file, format!("{cmd}\n")).map_err(|e| e.to_string())?,
        None => {
            let _ = std::fs::remove_file(&prev_file);
        }
    }
    std::fs::write(script_path(), SCRIPT).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(script_path(), std::fs::Permissions::from_mode(0o755));
    }
    let mut line = json!({ "type": "command", "command": our_command() });
    if let Some(padding) = previous.get("padding") {
        line["padding"] = padding.clone();
    }
    match settings.as_object_mut() {
        Some(obj) => {
            obj.insert("statusLine".into(), line);
        }
        None => return Err("settings_invalid".into()),
    }
    write_settings(&settings)?;
    Ok(state())
}

pub fn disconnect() -> Result<StatuslineState, String> {
    let mut settings = read_settings()?;
    if is_ours(&settings) {
        let previous: Value = std::fs::read_to_string(previous_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        if let Some(obj) = settings.as_object_mut() {
            if previous.is_null() {
                obj.remove("statusLine");
            } else {
                obj.insert("statusLine".into(), previous);
            }
        }
        write_settings(&settings)?;
    }
    let _ = std::fs::remove_file(bridge_dir().join("previous-command"));
    let _ = std::fs::remove_file(previous_path());
    Ok(state())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rate_limits_in_seconds_and_ms() {
        let v = json!({"rate_limits": {
            "seven_day": {"used_percentage": 49.5, "resets_at": 1794418850},
            "five_hour": {"used_percentage": 12, "resets_at": 1794155537000i64}
        }});
        let w = parse_windows(&v);
        assert_eq!(w[0].key, "five_hour");
        assert_eq!(w[0].resets_at, Some(1794155537));
        assert_eq!(w[1].used_percent, 49.5);
        assert_eq!(w[1].window_minutes, Some(10080));
    }

    #[test]
    fn missing_rate_limits_is_empty() {
        assert!(parse_windows(&json!({"model": {}})).is_empty());
    }
}

#[cfg(test)]
mod fs_tests {
    use super::*;

    /// Round-trips connect/disconnect against a fake HOME:
    /// `HOME=/tmp/x cargo test -- --ignored statusline_roundtrip`.
    #[test]
    #[ignore]
    fn statusline_roundtrip() {
        let home = dirs::home_dir().unwrap();
        assert!(home.to_string_lossy().contains("sl-home"), "run with a fake HOME");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let original = "{\n  \"zeta\": 1,\n  \"statusLine\": {\"type\": \"command\", \"command\": \"echo old\", \"padding\": 2},\n  \"alpha\": true\n}\n";
        std::fs::write(settings_path(), original).unwrap();

        let st = connect().unwrap();
        assert!(st.connected);
        let after: Value = serde_json::from_str(&std::fs::read_to_string(settings_path()).unwrap()).unwrap();
        println!("connected settings:\n{}", serde_json::to_string_pretty(&after).unwrap());
        assert_eq!(after["statusLine"]["padding"], 2);
        assert!(home.join(".claude/settings.json.usage-float.bak").exists());
        assert_eq!(std::fs::read_to_string(bridge_dir().join("previous-command")).unwrap().trim(), "echo old");

        let st = disconnect().unwrap();
        assert!(!st.connected);
        let restored: Value = serde_json::from_str(&std::fs::read_to_string(settings_path()).unwrap()).unwrap();
        let orig: Value = serde_json::from_str(original).unwrap();
        assert_eq!(restored, orig);
        let keys: Vec<_> = restored.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["zeta", "statusLine", "alpha"], "key order preserved");
        println!("restored OK, keys {keys:?}");
    }
}
