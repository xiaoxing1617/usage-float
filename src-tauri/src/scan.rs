//! Reads local usage logs written by Claude Code and Codex.
//!
//! - Claude Code: `~/.claude/projects/**/*.jsonl` (and `~/.config/claude/projects`).
//!   Each assistant message carries `message.usage`. The same message can be
//!   logged more than once (resumed / forked sessions), so events are
//!   de-duplicated by `message.id + requestId`.
//! - Codex: `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions`.
//!   `token_count` events carry a cumulative `total_token_usage` per session;
//!   per-event usage is the delta between consecutive totals. The same events
//!   carry `rate_limits` (5-hour / weekly windows) and `plan_type`.
//!
//! Parsed results are cached per file by (mtime, size), so refreshes only
//! re-read files that changed.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Openai,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub provider: Provider,
    pub ts_ms: i64,
    pub model: String,
    /// Uncached input tokens.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    /// Fast mode bills at a multiple of the standard rate.
    pub fast: bool,
    pub dedupe_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct QuotaWindow {
    /// "five_hour", "seven_day", "seven_day_opus", ...
    pub key: String,
    pub used_percent: f64,
    /// Unix seconds.
    pub resets_at: Option<i64>,
    pub window_minutes: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct CodexLimits {
    pub plan: Option<String>,
    pub windows: Vec<QuotaWindow>,
    /// Unix ms of the log event the limits came from.
    pub observed_at: Option<i64>,
}

/// Claude Code logs a `rate_limit_info` entry when a request is rejected
/// because a limit was reached. Used as a local fallback for the quota card.
#[derive(Clone, Debug, Serialize)]
pub struct ClaudeLimitHit {
    /// "five_hour", "seven_day", ...
    pub kind: String,
    /// Unix seconds.
    pub resets_at: i64,
    /// Unix ms when it was logged.
    pub observed_at: i64,
}

pub struct ScanResult {
    pub events: Vec<Event>,
    pub codex: Option<CodexLimits>,
    /// Latest hit per limit kind whose reset time is still in the future.
    pub claude_hits: Vec<ClaudeLimitHit>,
}

struct FileEntry {
    mtime: SystemTime,
    size: u64,
    events: Vec<Event>,
    limits: Option<CodexLimits>,
    hits: Vec<ClaudeLimitHit>,
}

#[derive(Default)]
pub struct ScanCache {
    files: HashMap<PathBuf, FileEntry>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn claude_roots() -> Vec<PathBuf> {
    let h = home();
    let mut v = vec![h.join(".claude/projects"), h.join(".config/claude/projects")];
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        for d in dir.split(',') {
            v.push(PathBuf::from(d.trim()).join("projects"));
        }
    }
    v
}

fn codex_roots() -> Vec<PathBuf> {
    let base = std::env::var("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|_| home().join(".codex"));
    vec![base.join("sessions"), base.join("archived_sessions")]
}

fn jsonl_files(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for r in roots {
        if !r.exists() {
            continue;
        }
        for e in WalkDir::new(r).follow_links(false).into_iter().flatten() {
            if e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "jsonl") {
                out.push(e.into_path());
            }
        }
    }
    out
}

fn parse_ts(v: &serde_json::Value) -> Option<i64> {
    let s = v.get("timestamp")?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn u(v: Option<&serde_json::Value>) -> u64 {
    v.and_then(|x| x.as_u64()).unwrap_or(0)
}

fn parse_claude_file(path: &Path) -> (Vec<Event>, Vec<ClaudeLimitHit>) {
    let Ok(f) = std::fs::File::open(path) else { return (vec![], vec![]) };
    let mut out = Vec::new();
    let mut hits = Vec::new();
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        let has_limit = line.contains("\"rate_limit_info\"");
        if !has_limit && !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if has_limit {
            if let Some(info) = find_key(&v, "rate_limit_info") {
                if info.get("status").and_then(|x| x.as_str()) == Some("rejected") {
                    if let (Some(kind), Some(resets_at)) = (
                        info.get("rateLimitType").and_then(|x| x.as_str()),
                        info.get("resetsAt").and_then(|x| x.as_i64()),
                    ) {
                        hits.push(ClaudeLimitHit { kind: kind.into(), resets_at, observed_at: parse_ts(&v).unwrap_or(0) });
                    }
                }
            }
        }
        let Some(msg) = v.get("message") else { continue };
        let Some(usage) = msg.get("usage") else { continue };
        let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("");
        if model.is_empty() || model.starts_with('<') {
            continue; // "<synthetic>" placeholder messages
        }
        let Some(ts_ms) = parse_ts(&v) else { continue };
        let cc = usage.get("cache_creation");
        let (w5, w1) = match cc {
            Some(c) => (u(c.get("ephemeral_5m_input_tokens")), u(c.get("ephemeral_1h_input_tokens"))),
            None => (u(usage.get("cache_creation_input_tokens")), 0),
        };
        let dedupe_key = match (msg.get("id").and_then(|x| x.as_str()), v.get("requestId").and_then(|x| x.as_str())) {
            (Some(id), Some(req)) => Some(format!("{id}:{req}")),
            (Some(id), None) => Some(id.to_string()),
            _ => None,
        };
        out.push(Event {
            provider: Provider::Claude,
            ts_ms,
            model: model.to_string(),
            input: u(usage.get("input_tokens")),
            output: u(usage.get("output_tokens")),
            cache_read: u(usage.get("cache_read_input_tokens")),
            cache_write_5m: w5,
            cache_write_1h: w1,
            fast: usage.get("speed").and_then(|s| s.as_str()) == Some("fast"),
            dedupe_key,
        });
    }
    (out, hits)
}

/// Depth-first search for an object key anywhere in a JSON value.
fn find_key<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match v {
        serde_json::Value::Object(m) => m.get(key).or_else(|| m.values().find_map(|x| find_key(x, key))),
        serde_json::Value::Array(a) => a.iter().find_map(|x| find_key(x, key)),
        _ => None,
    }
}

#[derive(Default, Clone, Copy)]
struct CodexTotals {
    input: u64,
    cached: u64,
    cache_write: u64,
    output: u64,
}

fn parse_codex_file(path: &Path) -> (Vec<Event>, Option<CodexLimits>) {
    let Ok(f) = std::fs::File::open(path) else { return (vec![], None) };
    let mut out = Vec::new();
    let mut model = String::from("gpt-unknown");
    let mut prev = CodexTotals::default();
    let mut limits: Option<CodexLimits> = None;
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        let is_ctx = line.contains("\"turn_context\"");
        let is_tok = line.contains("\"token_count\"");
        if !is_ctx && !is_tok {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let Some(p) = v.get("payload") else { continue };
        if is_ctx && v.get("type").and_then(|t| t.as_str()) == Some("turn_context") {
            if let Some(m) = p.get("model").and_then(|m| m.as_str()) {
                model = m.to_string();
            }
            continue;
        }
        if p.get("type").and_then(|t| t.as_str()) != Some("token_count") {
            continue;
        }
        let ts_ms = parse_ts(&v).unwrap_or(0);
        if let Some(rl) = p.get("rate_limits").filter(|r| r.is_object()) {
            let mut windows = Vec::new();
            for key in ["primary", "secondary"] {
                if let Some(w) = rl.get(key).filter(|w| w.is_object()) {
                    let wm = w.get("window_minutes").and_then(|x| x.as_i64());
                    windows.push(QuotaWindow {
                        key: match wm {
                            Some(300) => "five_hour".into(),
                            Some(10080) => "seven_day".into(),
                            _ => key.into(),
                        },
                        used_percent: w.get("used_percent").and_then(|x| x.as_f64()).unwrap_or(0.0),
                        resets_at: w.get("resets_at").and_then(|x| x.as_i64()),
                        window_minutes: wm,
                    });
                }
            }
            limits = Some(CodexLimits {
                plan: rl.get("plan_type").and_then(|x| x.as_str()).map(String::from),
                windows,
                observed_at: Some(ts_ms),
            });
        }
        let Some(total) = p.get("info").and_then(|i| i.get("total_token_usage")) else { continue };
        let cur = CodexTotals {
            input: u(total.get("input_tokens")),
            cached: u(total.get("cached_input_tokens")),
            cache_write: u(total.get("cache_write_input_tokens")),
            output: u(total.get("output_tokens")),
        };
        // Totals only grow within a session; a drop means a new counter (e.g. after compaction).
        let base = if cur.input < prev.input || cur.output < prev.output { CodexTotals::default() } else { prev };
        prev = cur;
        let d_in = cur.input - base.input;
        let d_cached = cur.cached.saturating_sub(base.cached).min(d_in);
        let d_write = cur.cache_write.saturating_sub(base.cache_write);
        let d_out = cur.output - base.output;
        if d_in == 0 && d_out == 0 {
            continue; // repeated event with unchanged totals
        }
        out.push(Event {
            provider: Provider::Openai,
            ts_ms,
            model: model.clone(),
            input: d_in - d_cached - d_write.min(d_in - d_cached),
            output: d_out,
            cache_read: d_cached,
            cache_write_5m: d_write.min(d_in - d_cached),
            cache_write_1h: 0,
            fast: false,
            dedupe_key: None,
        });
    }
    (out, limits)
}

impl ScanCache {
    /// Re-reads changed files and returns all events (deduplicated) plus the newest Codex limits.
    pub fn refresh(&mut self) -> ScanResult {
        let mut seen_paths = std::collections::HashSet::new();
        let sources: [(Vec<PathBuf>, Provider); 2] =
            [(jsonl_files(&claude_roots()), Provider::Claude), (jsonl_files(&codex_roots()), Provider::Openai)];
        for (files, provider) in sources {
            for path in files {
                let Ok(meta) = std::fs::metadata(&path) else { continue };
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let size = meta.len();
                seen_paths.insert(path.clone());
                if let Some(e) = self.files.get(&path) {
                    if e.mtime == mtime && e.size == size {
                        continue;
                    }
                }
                let (events, limits, hits) = match provider {
                    Provider::Claude => {
                        let (e, h) = parse_claude_file(&path);
                        (e, None, h)
                    }
                    Provider::Openai => {
                        let (e, l) = parse_codex_file(&path);
                        (e, l, vec![])
                    }
                };
                self.files.insert(path, FileEntry { mtime, size, events, limits, hits });
            }
        }
        self.files.retain(|p, _| seen_paths.contains(p));

        let mut keys = std::collections::HashSet::new();
        let mut events = Vec::new();
        let mut latest: Option<CodexLimits> = None;
        let now_s = chrono::Utc::now().timestamp();
        let mut hits: HashMap<String, ClaudeLimitHit> = HashMap::new();
        for entry in self.files.values() {
            for h in entry.hits.iter().filter(|h| h.resets_at > now_s) {
                if hits.get(&h.kind).is_none_or(|cur| h.observed_at > cur.observed_at) {
                    hits.insert(h.kind.clone(), h.clone());
                }
            }
            for e in &entry.events {
                if let Some(k) = &e.dedupe_key {
                    if !keys.insert(k.clone()) {
                        continue;
                    }
                }
                events.push(e.clone());
            }
            if let Some(l) = &entry.limits {
                if latest.as_ref().is_none_or(|cur| l.observed_at > cur.observed_at) {
                    latest = Some(l.clone());
                }
            }
        }
        ScanResult { events, codex: latest, claude_hits: hits.into_values().collect() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test against the real logs on this machine: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn scan_local_logs() {
        let mut c = ScanCache::default();
        let t = std::time::Instant::now();
        let r = c.refresh();
        let (events, limits) = (r.events, r.codex);
        println!("claude hits: {:?}", r.claude_hits);
        println!("first scan: {} events in {:?}", events.len(), t.elapsed());
        let t = std::time::Instant::now();
        c.refresh();
        println!("cached rescan: {:?}", t.elapsed());
        let mut by: HashMap<(Provider, String), (u64, u64, u64, u64)> = HashMap::new();
        for e in &events {
            let a = by.entry((e.provider, e.model.clone())).or_default();
            a.0 += e.input; a.1 += e.output; a.2 += e.cache_read; a.3 += e.cache_write_5m + e.cache_write_1h;
        }
        for (k, v) in by { println!("{k:?} in={} out={} cr={} cw={}", v.0, v.1, v.2, v.3); }
        println!("codex limits: {limits:?}");
    }
}
