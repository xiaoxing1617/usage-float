//! Conversations that are running right now, from local session logs.
//!
//! - Claude Code: `~/.claude/projects/<project>/<session>.jsonl`. A session is
//!   running when its last conversational record is a prompt, a tool call or a
//!   tool result (not a final answer, a stop-hook summary or an interruption).
//!   The title is the session's `custom-title` record (what the app shows in
//!   its sidebar), falling back to the last prompt.
//! - Codex: `~/.codex/sessions/**/rollout-*.jsonl`. Running when the last
//!   `task_started` event has no later `task_complete` / `turn_aborted`.
//!   The title comes from `~/.codex/session_index.jsonl` (`thread_name`).
//!
//! Only files written in the last few minutes are read, and only their tail.
//! Nothing is sent anywhere.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, SystemTime};

#[derive(Serialize, Clone, Debug)]
pub struct Task {
    /// Session id (stable key for the UI).
    pub id: String,
    pub title: Option<String>,
    /// Unix ms when the current turn started, if known.
    pub started_at: Option<i64>,
    /// Unix ms when the conversation was created, if known.
    pub created_at: Option<i64>,
    /// Can be opened in the Claude desktop app / Codex app.
    pub openable: bool,
}

#[derive(Serialize, Default, Clone, Debug)]
pub struct Activity {
    pub claude: u32,
    pub codex: u32,
    pub claude_tasks: Vec<Task>,
    pub codex_tasks: Vec<Task>,
}

/// A log untouched for this long is treated as finished or abandoned.
const STALE: Duration = Duration::from_secs(10 * 60);
const TAIL_BYTES: u64 = 256 * 1024;

pub fn scan() -> Activity {
    let home = dirs::home_dir().unwrap_or_default();
    let desktop = desktop_sessions();
    let claude_tasks = collect(&CLAUDE_FILES, &home.join(".claude/projects"), 2, |p| p.extension().is_some_and(|e| e == "jsonl"), |p, tail, _| {
        let (title, started_at) = claude_task(tail)?;
        let id = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        let d = desktop.get(&id);
        Some(Task {
            title: d.and_then(|d| d.title.clone()).or(title),
            // A long turn can push the prompt out of the tail; the desktop
            // app also records when the last message was sent.
            started_at: started_at.or_else(|| d.and_then(|d| d.last_prompt_at)),
            created_at: d.and_then(|d| d.created_at).or_else(|| first_timestamp(p)),
            openable: d.is_some(),
            id,
        })
    });
    let index = codex_index(&home.join(".codex/session_index.jsonl"));
    let codex_tasks = collect(
        &CODEX_FILES,
        &home.join(".codex/sessions"),
        4,
        |p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl")),
        |p, tail, fresh| {
            let (started_at, last_prompt) = codex_task(tail, fresh)?;
            let id = codex_id(p.file_name()?.to_str()?).unwrap_or_default();
            let title = index.get(&id).cloned().or(last_prompt);
            let openable = is_uuid(&id);
            Some(Task { title, started_at, created_at: first_timestamp(p), openable, id })
        },
    );
    Activity { claude: claude_tasks.len() as u32, codex: codex_tasks.len() as u32, claude_tasks, codex_tasks }
}

type FileCache = std::sync::Mutex<Option<HashMap<std::path::PathBuf, (SystemTime, u64, bool, Option<Task>)>>>;
static CLAUDE_FILES: FileCache = std::sync::Mutex::new(None);
static CODEX_FILES: FileCache = std::sync::Mutex::new(None);

/// Walks `root` for recently written session files. A file whose size and
/// modification time haven't changed since the last scan isn't read again.
fn collect(
    cache: &FileCache,
    root: &Path,
    depth: usize,
    want: impl Fn(&Path) -> bool,
    task: impl Fn(&Path, &str, bool) -> Option<Task>,
) -> Vec<Task> {
    let now = SystemTime::now();
    let mut out = Vec::new();
    let mut guard = cache.lock().unwrap();
    let cache = guard.get_or_insert_with(HashMap::new);
    let mut seen = std::collections::HashSet::new();
    for e in walkdir::WalkDir::new(root).min_depth(depth).max_depth(depth).into_iter().flatten() {
        if !e.file_type().is_file() || !want(e.path()) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(e.path()) else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        let age = now.duration_since(mtime).unwrap_or_default();
        if age > STALE {
            continue;
        }
        let fresh = age < Duration::from_secs(120);
        let path = e.path().to_path_buf();
        seen.insert(path.clone());
        let hit = cache.get(&path).filter(|(m, len, f, _)| *m == mtime && *len == meta.len() && *f == fresh);
        let result = match hit {
            Some((_, _, _, r)) => r.clone(),
            None => {
                let r = read_tail(e.path()).and_then(|tail| task(e.path(), &tail, fresh));
                cache.insert(path, (mtime, meta.len(), fresh, r.clone()));
                r
            }
        };
        out.extend(result);
    }
    cache.retain(|p, _| seen.contains(p));
    // Oldest turn first, so the list order stays stable while tasks run.
    out.sort_by_key(|t| (t.started_at.unwrap_or(i64::MAX), t.id.clone()));
    out
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

fn ts(v: &Value) -> Option<i64> {
    v["timestamp"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp_millis())
}

/// Collapses whitespace and shortens to `max` characters.
fn short(s: &str, max: usize) -> Option<String> {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        return None;
    }
    Some(if s.chars().count() > max { s.chars().take(max).collect::<String>() + "…" } else { s })
}

fn user_text(v: &Value) -> Option<String> {
    let c = &v["message"]["content"];
    if let Some(s) = c.as_str() {
        return Some(s.to_string());
    }
    let a = c.as_array()?;
    if a.iter().any(|x| x["type"] == "tool_result") {
        return None;
    }
    Some(a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" "))
}

#[derive(PartialEq)]
enum State {
    Unknown,
    Running,
    Idle,
}

/// `Some((title, turn_started_at))` when the Claude Code session is running.
pub fn claude_task(tail: &str) -> Option<(Option<String>, Option<i64>)> {
    let mut state = State::Unknown;
    let mut started_at = None;
    let mut title: Option<String> = None;
    let mut agent: Option<String> = None;
    let mut last_prompt: Option<String> = None;
    for line in tail.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v["type"].as_str() {
            Some("custom-title") if title.is_none() => title = v["customTitle"].as_str().and_then(|s| short(s, 80)),
            Some("agent-name") if agent.is_none() => agent = v["agentName"].as_str().and_then(|s| short(s, 80)),
            Some("last-prompt") if last_prompt.is_none() => last_prompt = v["lastPrompt"].as_str().and_then(|s| short(s, 60)),
            _ => {}
        }
        if v["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        match v["type"].as_str() {
            Some("system") if state == State::Unknown => {
                if matches!(v["subtype"].as_str(), Some("stop_hook_summary") | Some("turn_duration")) {
                    return None;
                }
            }
            Some("assistant") if state == State::Unknown => {
                let stop = v["message"]["stop_reason"].as_str();
                if matches!(stop, Some("end_turn") | Some("stop_sequence") | Some("max_tokens") | Some("refusal")) {
                    return None;
                }
                state = State::Running;
            }
            Some("user") => {
                let text = user_text(&v);
                if state == State::Unknown {
                    if let Some(t) = &text {
                        if t.contains("[Request interrupted by user") || t.contains("<local-command-") || t.contains("<command-name>") {
                            state = State::Idle;
                            break;
                        }
                    }
                    state = State::Running;
                }
                // The newest real prompt is where this turn started.
                if started_at.is_none() && text.as_deref().is_some_and(|t| !t.trim().is_empty() && !t.contains("<command-name>")) {
                    started_at = ts(&v);
                    if last_prompt.is_none() {
                        last_prompt = text.as_deref().and_then(|t| short(t, 60));
                    }
                }
            }
            _ => {}
        }
        if state == State::Running && started_at.is_some() && title.is_some() {
            break;
        }
    }
    (state == State::Running).then(|| (title.or(agent).or(last_prompt), started_at))
}

/// `Some((turn_started_at, last_prompt))` when the Codex rollout is running.
pub fn codex_task(tail: &str, fresh: bool) -> Option<(Option<i64>, Option<String>)> {
    let mut running = None;
    let mut started_at = None;
    let mut prompt = None;
    for line in tail.lines().rev() {
        if !line.contains("\"event_msg\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v["payload"]["type"].as_str() {
            Some("task_started") if running.is_none() => {
                running = Some(true);
                started_at = ts(&v);
            }
            Some("task_complete") | Some("turn_aborted") | Some("shutdown_complete") if running.is_none() => return None,
            Some("user_message") if prompt.is_none() => prompt = v["payload"]["message"].as_str().and_then(|s| short(s, 60)),
            _ => {}
        }
        if running.is_some() && prompt.is_some() {
            break;
        }
    }
    // A long turn may push its start out of the tail; trust very recent writes.
    running.unwrap_or(fresh).then_some((started_at, prompt))
}

/// Unix ms of the first timestamped record (when the conversation was created).
fn first_timestamp(p: &Path) -> Option<i64> {
    // A conversation's creation time never changes, so remember it per file.
    static SEEN: std::sync::Mutex<Option<HashMap<std::path::PathBuf, Option<i64>>>> = std::sync::Mutex::new(None);
    let mut guard = SEEN.lock().unwrap();
    let seen = guard.get_or_insert_with(HashMap::new);
    if let Some(t) = seen.get(p) {
        return *t;
    }
    let t = read_first_timestamp(p);
    if seen.len() > 4096 {
        seen.clear();
    }
    seen.insert(p.to_path_buf(), t);
    t
}

fn read_first_timestamp(p: &Path) -> Option<i64> {
    use std::io::BufRead;
    let f = std::fs::File::open(p).ok()?;
    for line in std::io::BufReader::new(f).lines().take(20) {
        let Ok(line) = line else { break };
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if let Some(t) = ts(&v).or_else(|| ts(&v["payload"])) {
                return Some(t);
            }
        }
    }
    None
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// A Claude desktop app Code session (`claude-code-sessions/**/local_*.json`).
#[derive(Clone)]
struct DesktopSession {
    local_id: String,
    title: Option<String>,
    created_at: Option<i64>,
    /// When the user last sent a message (the current turn's start).
    last_prompt_at: Option<i64>,
}

/// Desktop sessions by Claude Code session id, cached by file modification time.
fn desktop_sessions() -> HashMap<String, DesktopSession> {
    use std::sync::Mutex;
    static CACHE: Mutex<Option<HashMap<std::path::PathBuf, (SystemTime, Option<(String, DesktopSession)>)>>> = Mutex::new(None);
    let root = dirs::data_dir().unwrap_or_default().join("Claude/claude-code-sessions");
    let mut guard = CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(HashMap::new);
    let mut seen = std::collections::HashSet::new();
    for e in walkdir::WalkDir::new(&root).max_depth(3).into_iter().flatten() {
        let p = e.path();
        let ok = p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("local_") && n.ends_with(".json"));
        if !ok || !e.file_type().is_file() {
            continue;
        }
        let Ok(mtime) = std::fs::metadata(p).and_then(|m| m.modified()) else { continue };
        seen.insert(p.to_path_buf());
        if cache.get(p).is_some_and(|(m, _)| *m == mtime) {
            continue;
        }
        let parsed = std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| {
            let local_id = v["sessionId"].as_str().filter(|s| valid_local_id(s))?.to_string();
            let cli = v["cliSessionId"].as_str()?.to_string();
            Some((cli, DesktopSession {
                local_id,
                title: v["title"].as_str().and_then(|s| short(s, 80)),
                created_at: v["createdAt"].as_i64(),
                last_prompt_at: v["latestUserFrameAt"].as_i64(),
            }))
        });
        cache.insert(p.to_path_buf(), (mtime, parsed));
    }
    cache.retain(|p, _| seen.contains(p));
    cache.values().filter_map(|(_, v)| v.clone()).collect()
}

fn valid_local_id(s: &str) -> bool {
    s.strip_prefix("local_").is_some_and(|r| !r.is_empty() && r.len() <= 64 && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// Opens a conversation in its app. Only builds the two known deep links,
/// from validated ids, so nothing else can be opened through this.
/// Errors: "not_found" (conversation deleted), "app_missing", "not_openable".
pub fn open_task(provider: &str, id: &str) -> Result<(), String> {
    let url = match provider {
        "openai" if is_uuid(id) => {
            if !codex_exists(id) {
                return Err("not_found".into());
            }
            format!("codex://threads/{id}")
        }
        "claude" if is_uuid(id) => {
            let d = desktop_sessions().remove(id).ok_or("not_found")?;
            format!("claude://code/continue?session={}", d.local_id)
        }
        _ => return Err("not_openable".into()),
    };
    // Fails when no installed app handles the link.
    crate::platform::open_url(&url)
}

/// The Codex conversation still has a rollout file (live or archived).
fn codex_exists(id: &str) -> bool {
    let home = dirs::home_dir().unwrap_or_default();
    [home.join(".codex/sessions"), home.join(".codex/archived_sessions")].iter().any(|root| {
        walkdir::WalkDir::new(root)
            .max_depth(4)
            .into_iter()
            .flatten()
            .any(|e| e.file_type().is_file() && e.file_name().to_str().is_some_and(|n| n.starts_with("rollout-") && n.contains(id)))
    })
}

/// Session id from `rollout-2026-11-10T13-14-40-<uuid>[_<uuid>].jsonl`.
fn codex_id(name: &str) -> Option<String> {
    let rest = name.strip_prefix("rollout-")?.get(20..)?;
    rest.get(..36).map(String::from)
}

/// Codex thread names, re-read only when the index file changes.
fn codex_index(path: &Path) -> HashMap<String, String> {
    static CACHE: std::sync::Mutex<Option<(SystemTime, HashMap<String, String>)>> = std::sync::Mutex::new(None);
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let mut guard = CACHE.lock().unwrap();
    if let (Some(m), Some((cm, map))) = (mtime, guard.as_ref()) {
        if *cm == m {
            return map.clone();
        }
    }
    let map = read_codex_index(path);
    if let Some(m) = mtime {
        *guard = Some((m, map.clone()));
    }
    map
}

fn read_codex_index(path: &Path) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let Ok(text) = std::fs::read_to_string(path) else { return m };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let (Some(id), Some(name)) = (v["id"].as_str(), v["thread_name"].as_str().and_then(|s| short(s, 80))) {
            m.insert(id.to_string(), name);
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_states() {
        let prompt = r#"{"type":"user","timestamp":"2026-11-10T10:00:00Z","message":{"role":"user","content":"fix the login page"}}"#;
        let title = r#"{"type":"custom-title","customTitle":"Login fix"}"#;
        let tool = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use"}]}}"#;
        let result = r#"{"type":"user","timestamp":"2026-11-10T10:01:00Z","message":{"role":"user","content":[{"type":"tool_result"}]}}"#;
        let done = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}}"#;
        let hook = r#"{"type":"system","subtype":"stop_hook_summary"}"#;
        let cost = r#"{"type":"cost-state"}"#;
        let interrupt = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;

        let r = claude_task(&[title, prompt, tool, result].join("\n")).unwrap();
        assert_eq!(r.0.as_deref(), Some("Login fix"));
        assert_eq!(r.1, Some(1794304800000));
        let r = claude_task(&[prompt, tool, cost].join("\n")).unwrap();
        assert_eq!(r.0.as_deref(), Some("fix the login page"));
        assert!(claude_task(&[tool, done, hook, cost].join("\n")).is_none());
        assert!(claude_task(&[tool, interrupt].join("\n")).is_none());
        assert!(claude_task(cost).is_none());
    }

    #[test]
    fn codex_states() {
        let start = r#"{"timestamp":"2026-11-10T10:00:00Z","type":"event_msg","payload":{"type":"task_started"}}"#;
        let user = r#"{"type":"event_msg","payload":{"type":"user_message","message":"add dark mode"}}"#;
        let done = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        let other = r#"{"type":"response_item","payload":{"type":"message"}}"#;
        let r = codex_task(&[done, user, start, other].join("\n"), false).unwrap();
        assert_eq!(r, (Some(1794304800000), Some("add dark mode".into())));
        assert!(codex_task(&[start, done, other].join("\n"), false).is_none());
        assert!(codex_task(other, true).is_some());
        assert!(codex_task(other, false).is_none());
    }

    #[test]
    fn codex_ids() {
        let n = "rollout-2026-11-10T13-14-40-01a14a9e-4b61-72f0-9f57-ff86914a5453_01a1c3e1-3be7-7181-9dbd-dc7b3e03ef52.jsonl";
        assert_eq!(codex_id(n).as_deref(), Some("01a14a9e-4b61-72f0-9f57-ff86914a5453"));
        let n = "rollout-2026-11-10T13-14-40-01a14a9e-4b61-72f0-9f57-ff86914a5453.jsonl";
        assert_eq!(codex_id(n).as_deref(), Some("01a14a9e-4b61-72f0-9f57-ff86914a5453"));
    }

    #[test]
    fn open_rejects_missing_and_bad_ids() {
        // A well-formed id that doesn't exist is reported, and nothing is opened.
        assert_eq!(open_task("openai", "00000000-0000-0000-0000-000000000000").unwrap_err(), "not_found");
        assert_eq!(open_task("claude", "00000000-0000-0000-0000-000000000000").unwrap_err(), "not_found");
        assert_eq!(open_task("openai", "../../etc").unwrap_err(), "not_openable");
        assert_eq!(open_task("other", "00000000-0000-0000-0000-000000000000").unwrap_err(), "not_openable");
    }

    #[test]
    #[ignore]
    fn bench_scan() {
        for i in 0..3 {
            let t = std::time::Instant::now();
            let a = scan();
            println!("scan {i}: {:?} ({} running)", t.elapsed(), a.claude + a.codex);
        }
    }

    #[test]
    #[ignore]
    fn live_scan() {
        println!("{:#?}", scan());
    }
}
