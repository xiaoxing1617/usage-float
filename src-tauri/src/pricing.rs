//! Model price history.
//!
//! When price fetching is enabled, the app downloads the community-maintained
//! LiteLLM price table (every 12 hours, driven by the UI) and stores each
//! distinct table as a *snapshot* with the time it became effective. A usage
//! event is priced with the snapshot that was in effect when the event
//! happened, so a price change never rewrites the cost of earlier usage.
//!
//! Prices are USD per 1M tokens and describe pay-as-you-go API rates; they are
//! an equivalent value for subscription users, not what they were billed.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PRICE_SOURCE_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    /// Unix ms from which these prices apply.
    pub effective_from: i64,
    pub source: String,
    pub prices: BTreeMap<String, Price>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PriceBook {
    /// Sorted by `effective_from`, oldest first.
    pub snapshots: Vec<Snapshot>,
    /// Unix ms of the last successful fetch (changed or not).
    pub last_checked: Option<i64>,
}

/// How a cost was priced, so the UI can be honest about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriceQuality {
    /// Snapshot in effect at the event time had this model.
    Exact,
    /// Event predates the first snapshot; earliest known price used.
    Backfilled,
    /// Model missing from the snapshot; a similar model's price was used.
    Approximate,
}

impl PriceBook {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp: PathBuf = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(self)?)?;
        std::fs::rename(tmp, path)
    }

    /// Records a freshly fetched table. Adds a snapshot only if any price differs
    /// from the latest one. Returns true when a new snapshot was added.
    pub fn record(&mut self, now_ms: i64, prices: BTreeMap<String, Price>) -> bool {
        self.last_checked = Some(now_ms);
        let changed = match self.snapshots.last() {
            Some(last) => {
                // Only compare models present in both; new models alone also count as a change.
                prices.iter().any(|(k, v)| last.prices.get(k) != Some(v))
            }
            None => true,
        };
        if changed {
            self.snapshots.push(Snapshot { effective_from: now_ms, source: "litellm".into(), prices });
        }
        changed
    }

    /// Price for `model` at time `ts_ms`.
    pub fn price_at(&self, model: &str, ts_ms: i64) -> Option<(Price, PriceQuality)> {
        if self.snapshots.is_empty() {
            return None;
        }
        let idx = self.snapshots.partition_point(|s| s.effective_from <= ts_ms);
        let (snap, backfilled) = if idx == 0 { (&self.snapshots[0], true) } else { (&self.snapshots[idx - 1], false) };
        let (price, exact) = find_model(&snap.prices, model)?;
        let q = if !exact {
            PriceQuality::Approximate
        } else if backfilled {
            PriceQuality::Backfilled
        } else {
            PriceQuality::Exact
        };
        Some((price, q))
    }
}

/// Exact id first, then the longest table key that is a prefix of the id
/// (handles date-suffixed ids such as `claude-sonnet-4-5-20250929`), then the
/// longest key the id is a prefix of.
fn find_model(prices: &BTreeMap<String, Price>, model: &str) -> Option<(Price, bool)> {
    let m = model.to_ascii_lowercase();
    if let Some(p) = prices.get(&m) {
        return Some((*p, true));
    }
    let best = prices
        .iter()
        .filter(|(k, _)| m.starts_with(k.as_str()))
        .max_by_key(|(k, _)| k.len());
    if let Some((_, p)) = best {
        return Some((*p, true));
    }
    // Fall back to the same family (e.g. "claude-opus-6" -> most recent "claude-opus-*").
    let family: String = m.split('-').take(2).collect::<Vec<_>>().join("-");
    prices
        .iter()
        .filter(|(k, _)| k.starts_with(&family))
        .max_by_key(|(k, _)| k.len())
        .map(|(_, p)| (*p, false))
}

/// Parses the LiteLLM table, keeping Anthropic and OpenAI chat models.
pub fn parse_litellm(raw: &serde_json::Value) -> BTreeMap<String, Price> {
    let mut out = BTreeMap::new();
    let Some(obj) = raw.as_object() else { return out };
    for (name, v) in obj {
        // Skip provider-prefixed aliases ("bedrock/...") and fine-tune ids ("ft:...").
        if name.contains('/') || name.contains(':') {
            continue;
        }
        let provider = v.get("litellm_provider").and_then(|x| x.as_str()).unwrap_or("");
        if provider != "anthropic" && provider != "openai" {
            continue;
        }
        let f = |key: &str| v.get(key).and_then(|x| x.as_f64()).map(|x| x * 1_000_000.0);
        let (Some(input), Some(output)) = (f("input_cost_per_token"), f("output_cost_per_token")) else { continue };
        let cache_read = f("cache_read_input_token_cost").unwrap_or(input);
        let cache_write_5m = f("cache_creation_input_token_cost").unwrap_or(input);
        let cache_write_1h = f("cache_creation_input_token_cost_above_1hr").unwrap_or(cache_write_5m);
        out.insert(name.to_ascii_lowercase(), Price { input, output, cache_read, cache_write_5m, cache_write_1h });
    }
    out
}

pub async fn fetch_latest() -> Result<BTreeMap<String, Price>, String> {
    let client = reqwest::Client::builder()
        .user_agent("usage-float")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let raw: serde_json::Value = client
        .get(PRICE_SOURCE_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let prices = parse_litellm(&raw);
    if prices.is_empty() {
        return Err("price table was empty".into());
    }
    Ok(prices)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(input: f64) -> Price {
        Price { input, output: input * 5.0, cache_read: input / 10.0, cache_write_5m: input * 1.25, cache_write_1h: input * 2.0 }
    }

    fn table(model: &str, input: f64) -> BTreeMap<String, Price> {
        BTreeMap::from([(model.to_string(), p(input))])
    }

    #[test]
    fn each_event_uses_price_in_effect_at_its_time() {
        let mut book = PriceBook::default();
        assert!(book.record(1_000, table("model-a", 5.0)));
        // Same prices fetched again: no new version.
        assert!(!book.record(2_000, table("model-a", 5.0)));
        // Price drops at t=3000.
        assert!(book.record(3_000, table("model-a", 3.0)));
        assert_eq!(book.snapshots.len(), 2);
        assert_eq!(book.last_checked, Some(3_000));

        let (before, q1) = book.price_at("model-a", 2_500).unwrap();
        let (after, q2) = book.price_at("model-a", 3_500).unwrap();
        assert_eq!(before.input, 5.0);
        assert_eq!(q1, PriceQuality::Exact);
        assert_eq!(after.input, 3.0);
        assert_eq!(q2, PriceQuality::Exact);

        // Usage before the first record uses the earliest price and is flagged.
        let (old, q0) = book.price_at("model-a", 10).unwrap();
        assert_eq!(old.input, 5.0);
        assert_eq!(q0, PriceQuality::Backfilled);
    }

    #[test]
    fn no_snapshots_means_no_cost() {
        assert!(PriceBook::default().price_at("model-a", 1).is_none());
    }

    #[test]
    fn dated_ids_and_unknown_family_members() {
        let mut t = table("claude-sonnet-4-5", 3.0);
        t.insert("claude-opus-5-5".into(), p(4.0));
        let (x, exact) = find_model(&t, "claude-sonnet-4-5-20250929").unwrap();
        assert!(exact);
        assert_eq!(x.input, 3.0);
        let (_, exact) = find_model(&t, "claude-opus-6").unwrap();
        assert!(!exact);
        assert!(find_model(&t, "gpt-6.1-sol").is_none());
    }

    /// Network test: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn fetch_real_table() {
        let prices = tauri::async_runtime::block_on(fetch_latest()).unwrap();
        println!("{} models", prices.len());
        for m in ["claude-opus-5-5", "claude-opus-4-8", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol"] {
            println!("{m}: {:?}", find_model(&prices, m));
        }
    }
}
