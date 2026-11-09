//! Public (egress) IP lookup — the address websites such as claude.ai and
//! chatgpt.com see, not the LAN address. Requests go through the system proxy
//! (reqwest `system-proxy`), so with a VPN/proxy on this shows its exit IP.
//!
//! Primary: Cloudflare's trace endpoint (no key; returns `ip=` and `loc=`).
//! Fallback: ipify (IP only).

use serde::Serialize;
use std::time::Duration;

#[derive(Serialize, Default)]
pub struct IpInfo {
    pub ip: Option<String>,
    /// ISO 3166-1 alpha-2 country code, e.g. "SG", when known.
    pub country: Option<String>,
    pub source: Option<String>,
    /// State / province, in the requested language when available.
    pub region: Option<String>,
    pub city: Option<String>,
    pub fetched_at: i64,
    pub error: Option<String>,
}

fn parse_trace(text: &str) -> (Option<String>, Option<String>) {
    let mut ip = None;
    let mut loc = None;
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

/// State/province and city from ipwho.is (HTTPS, no key). `lang` is one of
/// its supported codes; Chinese is only available as zh-CN.
async fn geo(client: &reqwest::Client, ip: &str, lang: &str) -> (Option<String>, Option<String>) {
    let url = format!("https://ipwho.is/{ip}?fields=success,region,city&lang={lang}");
    let Ok(resp) = client.get(url).send().await else { return (None, None) };
    let Ok(v) = resp.json::<serde_json::Value>().await else { return (None, None) };
    if v.get("success").and_then(|s| s.as_bool()) == Some(false) {
        return (None, None);
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string);
    (s("region"), s("city"))
}

pub async fn fetch(lang: &str) -> IpInfo {
    let mut info = fetch_ip().await;
    if let Some(ip) = info.ip.clone() {
        if let Ok(client) = reqwest::Client::builder().user_agent("usage-float").timeout(Duration::from_secs(8)).build() {
            let lang = if lang.starts_with("zh") { "zh-CN" } else { "en" };
            let (region, city) = geo(&client, &ip, lang).await;
            info.region = region;
            info.city = city;
        }
    }
    info
}

async fn fetch_ip() -> IpInfo {
    let now = chrono::Utc::now().timestamp_millis();
    let client = match reqwest::Client::builder()
        .user_agent("usage-float")
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => return IpInfo { fetched_at: now, error: Some(e.to_string()), ..Default::default() },
    };

    if let Ok(resp) = client.get("https://www.cloudflare.com/cdn-cgi/trace").send().await {
        if let Ok(text) = resp.text().await {
            if let (Some(ip), country) = parse_trace(&text) {
                return IpInfo { ip: Some(ip), country, source: Some("cloudflare".into()), fetched_at: now, ..Default::default() };
            }
        }
    }
    match client.get("https://api.ipify.org").send().await {
        Ok(resp) => match resp.text().await {
            Ok(t) if !t.trim().is_empty() && t.trim().len() < 64 => IpInfo {
                ip: Some(t.trim().to_string()),
                country: None,
                source: Some("ipify".into()),
                fetched_at: now,
                ..Default::default()
            },
            _ => IpInfo { fetched_at: now, error: Some("bad_response".into()), ..Default::default() },
        },
        Err(_) => IpInfo { fetched_at: now, error: Some("network".into()), ..Default::default() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cloudflare_trace() {
        let t = "fl=1\nh=www.cloudflare.com\nip=203.0.113.7\nts=1\nloc=sg\nwarp=off\n";
        assert_eq!(parse_trace(t), (Some("203.0.113.7".into()), Some("SG".into())));
        assert_eq!(parse_trace("ip=::1\nloc=XX"), (Some("::1".into()), None));
    }

    /// `cargo test -- --ignored fetch_real_ip --nocapture`
    #[test]
    #[ignore]
    fn fetch_real_ip() {
        let info = tauri::async_runtime::block_on(fetch("zh-CN"));
        println!("ip={:?} country={:?} region={:?} city={:?} source={:?} err={:?}", info.ip, info.country, info.region, info.city, info.source, info.error);
        assert!(info.ip.is_some());
    }
}
