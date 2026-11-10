//! Claude plan and remaining quota.
//!
//! - Plan: read from `~/.claude.json` (`oauthAccount.organizationType` and
//!   rate-limit tier), written by Claude Code when you sign in.
//! - Quota (UNOFFICIAL, opt-in): Claude Code stores its OAuth token in the
//!   macOS Keychain ("Claude Code-credentials"). With the user's consent we
//!   read it and call the same usage endpoint Claude Code's `/usage` uses.
//!   The token never leaves this machine except to api.anthropic.com, is kept
//!   only in memory, and is never refreshed or written back by this app.

use crate::scan::QuotaWindow;
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
pub struct ClaudePlan {
    /// e.g. "claude_pro", "claude_max"
    pub organization_type: Option<String>,
    /// e.g. "default_claude_max_20x"
    pub rate_limit_tier: Option<String>,
    pub billing_type: Option<String>,
}

pub fn read_plan() -> ClaudePlan {
    let path = dirs::home_dir().unwrap_or_default().join(".claude.json");
    let Ok(text) = std::fs::read_to_string(path) else { return ClaudePlan::default() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return ClaudePlan::default() };
    let a = &v["oauthAccount"];
    let s = |k: &str| a.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
    ClaudePlan {
        organization_type: s("organizationType"),
        rate_limit_tier: s("userRateLimitTier").or_else(|| s("organizationRateLimitTier")),
        billing_type: s("billingType"),
    }
}

#[cfg(target_os = "macos")]
fn read_token() -> Result<String, String> {
    let out = crate::platform::command("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("keychain_denied".into());
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|_| "keychain_format".to_string())?;
    v["claudeAiOauth"]["accessToken"].as_str().map(String::from).ok_or_else(|| "not_signed_in".into())
}

#[cfg(not(target_os = "macos"))]
fn read_token() -> Result<String, String> {
    let path = dirs::home_dir().unwrap_or_default().join(".claude/.credentials.json");
    let text = std::fs::read_to_string(path).map_err(|_| "not_signed_in".to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "keychain_format".to_string())?;
    v["claudeAiOauth"]["accessToken"].as_str().map(String::from).ok_or_else(|| "not_signed_in".into())
}

#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct QuotaResult {
    /// Last successful windows (may be older than this call if `error` is set).
    pub windows: Vec<QuotaWindow>,
    /// Unix ms when `windows` were fetched.
    pub fetched_at: Option<i64>,
    /// Stable error code for the UI, e.g. "rate_limited", "keychain_denied".
    pub error: Option<String>,
    /// Unix ms before which the app will not call the endpoint again.
    pub retry_at: Option<i64>,
}

#[derive(Default)]
pub struct QuotaCache {
    token: Option<String>,
    last: Option<QuotaResult>,
    blocked_until: i64,
    backoff_ms: i64,
    path: Option<std::path::PathBuf>,
}

const MIN_BACKOFF_MS: i64 = 5 * 60_000;
const MAX_BACKOFF_MS: i64 = 60 * 60_000;

impl QuotaCache {
    /// Restores the last good result from disk so a restart has something to show.
    pub fn new(path: std::path::PathBuf) -> Self {
        let last = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok());
        QuotaCache { last, path: Some(path), ..Default::default() }
    }

    fn result(&self, error: Option<String>) -> QuotaResult {
        let mut r = self.last.clone().unwrap_or_default();
        r.error = error;
        r.retry_at = (self.blocked_until > now_ms()).then_some(self.blocked_until);
        r
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Fetches quota windows. `force` re-reads the Keychain (prompting again if
/// access was denied) and ignores the rate-limit backoff.
pub async fn fetch_quota(cache: &std::sync::Mutex<QuotaCache>, force: bool) -> QuotaResult {
    let cached_token = {
        let mut c = cache.lock().unwrap();
        if force {
            c.token = None;
            c.blocked_until = 0;
        } else if now_ms() < c.blocked_until {
            return c.result(Some("rate_limited".into()));
        }
        c.token.clone()
    };
    let token = match cached_token {
        Some(t) => t,
        None => match tauri::async_runtime::spawn_blocking(read_token).await {
            Ok(Ok(t)) => {
                cache.lock().unwrap().token = Some(t.clone());
                t
            }
            Ok(Err(e)) => return cache.lock().unwrap().result(Some(e)),
            Err(e) => return cache.lock().unwrap().result(Some(e.to_string())),
        },
    };
    match request(&token).await {
        Ok(windows) => {
            let mut c = cache.lock().unwrap();
            c.backoff_ms = 0;
            c.blocked_until = 0;
            c.last = Some(QuotaResult { windows, fetched_at: Some(now_ms()), error: None, retry_at: None });
            if let (Some(path), Some(last)) = (&c.path, &c.last) {
                if let Some(dir) = path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(path, serde_json::to_vec(last).unwrap_or_default());
            }
            c.result(None)
        }
        Err(RequestError::RateLimited(retry_after_ms)) => {
            let mut c = cache.lock().unwrap();
            c.backoff_ms = (c.backoff_ms * 2).clamp(MIN_BACKOFF_MS, MAX_BACKOFF_MS);
            let wait = retry_after_ms.unwrap_or(c.backoff_ms).clamp(60_000, MAX_BACKOFF_MS);
            c.blocked_until = now_ms() + wait;
            c.result(Some("rate_limited".into()))
        }
        Err(RequestError::Unauthorized) => {
            let mut c = cache.lock().unwrap();
            // Token rotated by Claude Code; re-read from the keychain next time.
            c.token = None;
            c.result(Some("token_expired".into()))
        }
        Err(RequestError::Other(e)) => cache.lock().unwrap().result(Some(e)),
    }
}

enum RequestError {
    RateLimited(Option<i64>),
    Unauthorized,
    Other(String),
}

async fn request(token: &str) -> Result<Vec<QuotaWindow>, RequestError> {
    let client = reqwest::Client::builder()
        .user_agent("usage-float")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| RequestError::Other(e.to_string()))?;
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|_| RequestError::Other("network".into()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<i64>().ok())
            .map(|secs| secs * 1000);
        return Err(RequestError::RateLimited(retry));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(RequestError::Unauthorized);
    }
    if !status.is_success() {
        return Err(RequestError::Other(format!("http_{}", status.as_u16())));
    }
    let v: serde_json::Value = resp.json().await.map_err(|_| RequestError::Other("bad_response".into()))?;
    let mut windows = Vec::new();
    if let Some(obj) = v.as_object() {
        for (key, w) in obj {
            let Some(util) = w.get("utilization").and_then(|x| x.as_f64()) else { continue };
            let resets_at = w
                .get("resets_at")
                .and_then(|x| x.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp());
            let window_minutes = if key == "five_hour" { Some(300) } else if key.starts_with("seven_day") { Some(10080) } else { None };
            windows.push(QuotaWindow { key: key.clone(), used_percent: util, resets_at, window_minutes });
        }
    }
    // Stable order: five_hour, seven_day, then model-specific weekly windows.
    windows.sort_by_key(|w| (w.key != "five_hour", w.key != "seven_day", w.key.clone()));
    Ok(windows)
}
