//! Per-service network check, modelled on ip.net.coffee/claude and /gpt:
//!
//! * egress IP as the service sees it: `https://<service>/cdn-cgi/trace`
//!   (claude.ai and chatgpt.com sit behind Cloudflare, so split-tunnel
//!   proxies are respected);
//! * latency: round trip of a second request on the already-open connection;
//! * trust score 0–100 from ip.net.coffee's `/api/iprisk/<ip>`; IPs in
//!   regions the services do not support are scored 0, as on that site.
//!
//! Scores are cached per IP for 30 minutes to keep load on that site low.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SCORE_TTL_MS: i64 = 30 * 60_000;
/// Regions where Claude / ChatGPT block or heavily restrict access.
const RESTRICTED: &[&str] = &["CN", "HK", "MO", "RU", "KP", "IR", "SY", "CU", "BY", "VE"];

#[derive(Serialize, Clone, Default)]
pub struct NetCheck {
    pub service: String,
    pub ip: Option<String>,
    pub country: Option<String>,
    /// None when the service could not be reached.
    pub latency_ms: Option<u32>,
    pub trust_score: Option<u8>,
    pub restricted: bool,
    /// e.g. "residential", "datacenter" (from the risk lookup).
    pub ip_kind: Option<String>,
    pub checked_at: i64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ScoreCache(Mutex<HashMap<String, (i64, Option<u8>, Option<String>)>>);

fn trace_url(service: &str) -> Option<&'static str> {
    match service {
        "claude" => Some("https://claude.ai/cdn-cgi/trace"),
        "openai" => Some("https://chatgpt.com/cdn-cgi/trace"),
        _ => None,
    }
}

fn client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("usage-float")
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| e.to_string())
}

fn parse_trace(text: &str) -> (Option<String>, Option<String>) {
    let (mut ip, mut loc) = (None, None);
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("ip=") {
            ip = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("loc=") {
            let v = v.trim().to_uppercase();
            if v.len() == 2 && v != "XX" {
                loc = Some(v);
            }
        }
    }
    (ip, loc)
}

async fn lookup_score(ip: &str) -> Result<(Option<u8>, Option<String>), String> {
    let url = format!("https://ip.net.coffee/api/iprisk/{ip}");
    let v: serde_json::Value = client(10)?
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let score = v.get("trust_score").and_then(|s| s.as_f64()).map(|s| s.clamp(0.0, 100.0).round() as u8);
    let kind = v.get("asn_kind").and_then(|s| s.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    Ok((score, kind))
}

pub async fn check(cache: &ScoreCache, service: &str, force: bool) -> NetCheck {
    let now = chrono::Utc::now().timestamp_millis();
    let mut out = NetCheck { service: service.to_string(), checked_at: now, ..Default::default() };
    let Some(url) = trace_url(service) else {
        out.error = Some("unknown_service".into());
        return out;
    };
    let c = match client(8) {
        Ok(c) => c,
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };
    // First request opens the connection (DNS, proxy, TLS) and reads the IP;
    // the second, on the same kept-alive connection, measures round-trip latency.
    let text = match c.get(url).header("cache-control", "no-store").send().await {
        Ok(r) => r.text().await.unwrap_or_default(),
        Err(_) => {
            out.error = Some("unreachable".into());
            return out;
        }
    };
    let started = Instant::now();
    if let Ok(r) = c.get(url).header("cache-control", "no-store").send().await {
        let _ = r.bytes().await;
        out.latency_ms = Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32);
    }
    let (ip, country) = parse_trace(&text);
    out.restricted = country.as_deref().is_some_and(|cc| RESTRICTED.contains(&cc));
    out.country = country;
    let Some(ip) = ip else {
        out.error = Some("no_ip".into());
        return out;
    };
    out.ip = Some(ip.clone());

    let cached = cache.0.lock().ok().and_then(|m| m.get(&ip).cloned());
    let (score, kind) = match cached {
        Some((at, s, k)) if !force && now - at < SCORE_TTL_MS => (s, k),
        _ => match lookup_score(&ip).await {
            Ok((s, k)) => {
                if let Ok(mut m) = cache.0.lock() {
                    m.insert(ip.clone(), (now, s, k.clone()));
                }
                (s, k)
            }
            Err(_) => {
                out.error = Some("score_unavailable".into());
                (None, None)
            }
        },
    };
    out.ip_kind = kind;
    out.trust_score = if out.restricted { Some(0) } else { score };
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_parsing() {
        assert_eq!(parse_trace("ip=1.2.3.4\nloc=sg\n"), (Some("1.2.3.4".into()), Some("SG".into())));
    }

    /// `cargo test --lib trust:: -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_checks() {
        let cache = ScoreCache::default();
        for s in ["claude", "openai"] {
            let r = tauri::async_runtime::block_on(check(&cache, s, false));
            println!(
                "{s}: ip={:?} cc={:?} {:?}ms score={:?} kind={:?} err={:?}",
                r.ip, r.country, r.latency_ms, r.trust_score, r.ip_kind, r.error
            );
            assert!(r.ip.is_some());
        }
    }
}
