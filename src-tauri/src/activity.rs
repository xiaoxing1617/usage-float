//! Counts conversations that are running right now, from local session logs.
//!
//! - Claude Code: `~/.claude/projects/<project>/<session>.jsonl`. A session is
//!   running when its last conversational record is a prompt, a tool call or a
//!   tool result (not a final answer, a stop-hook summary or an interruption).
//! - Codex: `~/.codex/sessions/**/rollout-*.jsonl`. Running when the last
//!   `task_started` event has no later `task_complete` / `turn_aborted`.
//!
//! Only files written in the last few minutes are read, and only their tail.
//! Nothing is sent anywhere.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, SystemTime};

#[derive(Serialize, Default, Clone, Debug)]
pub struct Activity {
    pub claude: u32,
    pub codex: u32,
}

/// A log untouched for this long is treated as finished or abandoned.
const STALE: Duration = Duration::from_secs(10 * 60);
const TAIL_BYTES: u64 = 256 * 1024;

pub fn scan() -> Activity {
    let home = dirs::home_dir().unwrap_or_default();
    Activity {
        claude: count(&home.join(".claude/projects"), 2, |p| p.extension().is_some_and(|e| e == "jsonl"), claude_running),
        codex: count(&home.join(".codex/sessions"), 4, |p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        }, codex_running),
    }
}

fn count(root: &Path, depth: usize, want: impl Fn(&Path) -> bool, running: impl Fn(&str, bool) -> bool) -> u32 {
    let now = SystemTime::now();
    let mut n = 0;
    for e in walkdir::WalkDir::new(root).min_depth(depth).max_depth(depth).into_iter().flatten() {
        if !e.file_type().is_file() || !want(e.path()) {
            continue;
        }
        let Ok(age) = std::fs::metadata(e.path()).and_then(|m| m.modified()).map(|m| now.duration_since(m).unwrap_or_default()) else { continue };
        if age > STALE {
            continue;
        }
        if let Some(tail) = read_tail(e.path()) {
            if running(&tail, age < Duration::from_secs(120)) {
                n += 1;
            }
        }
    }
    n
}

fn read_tail(p: &Path) -> Option<String> {
    let mut f = std::fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        // Drop the partial first line.
        s = s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or_default();
    }
    Some(s)
}

/// Decides from the newest conversational record of a Claude Code session.
pub fn claude_running(tail: &str, _fresh: bool) -> bool {
    for line in tail.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        match v["type"].as_str() {
            Some("system") => {
                if matches!(v["subtype"].as_str(), Some("stop_hook_summary") | Some("turn_duration")) {
                    return false;
                }
            }
            Some("assistant") => {
                let stop = v["message"]["stop_reason"].as_str();
                return !matches!(stop, Some("end_turn") | Some("stop_sequence") | Some("max_tokens") | Some("refusal"));
            }
            Some("user") => {
                let c = &v["message"]["content"];
                let text = c.as_str().map(String::from).unwrap_or_else(|| {
                    c.as_array()
                        .map(|a| a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" "))
                        .unwrap_or_default()
                });
                if text.contains("[Request interrupted by user") {
                    return false;
                }
                // Local slash commands (e.g. /usage, /clear) don't start a turn.
                if text.contains("<local-command-") || text.contains("<command-name>") {
                    return false;
                }
                return true;
            }
            _ => {}
        }
    }
    false
}

/// Decides from the last task event of a Codex rollout.
pub fn codex_running(tail: &str, fresh: bool) -> bool {
    for line in tail.lines().rev() {
        if !line.contains("\"event_msg\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match v["payload"]["type"].as_str() {
            Some("task_started") => return true,
            Some("task_complete") | Some("turn_aborted") | Some("shutdown_complete") => return false,
            _ => {}
        }
    }
    // A long turn may push its start out of the tail; trust very recent writes.
    fresh
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_states() {
        let tool = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use"}]}}"#;
        let result = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result"}]}}"#;
        let done = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}}"#;
        let hook = r#"{"type":"system","subtype":"stop_hook_summary"}"#;
        let cost = r#"{"type":"cost-state"}"#;
        let interrupt = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;
        assert!(claude_running(&[tool, result].join("\n"), false));
        assert!(claude_running(&[result, tool, cost].join("\n"), false));
        assert!(!claude_running(&[tool, done, hook, cost].join("\n"), false));
        assert!(!claude_running(&[tool, interrupt].join("\n"), false));
        assert!(!claude_running(cost, false));
    }

    #[test]
    fn codex_states() {
        let start = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        let done = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        let other = r#"{"type":"response_item","payload":{"type":"message"}}"#;
        assert!(codex_running(&[done, start, other].join("\n"), false));
        assert!(!codex_running(&[start, done, other].join("\n"), false));
        assert!(codex_running(other, true));
        assert!(!codex_running(other, false));
    }

    #[test]
    #[ignore]
    fn live_scan() {
        println!("{:?}", scan());
    }
}
