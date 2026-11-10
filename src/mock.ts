// Dev-only fake backend so the UI can be previewed in a normal browser
// (`npm run dev`, then open http://localhost:1420). Not bundled in builds.
import type { PriceStatus, QuotaResult, UsageReport } from "./api";
import { ymd } from "./periods";

function report(withCost: boolean): UsageReport {
  const rows: UsageReport["rows"] = [];
  const now = new Date();
  for (let i = 0; i < 70; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const k = 0.4 + ((i * 37) % 10) / 10;
    const add = (provider: "claude" | "openai", model: string, tok: number, usd: number) =>
      rows.push({
        date: ymd(d),
        provider,
        model,
        input: Math.round(tok * 0.01),
        output: Math.round(tok * 0.03),
        cache_read: Math.round(tok * 0.9),
        cache_write: Math.round(tok * 0.06),
        cost_usd: withCost ? usd * k : null,
        price_quality: withCost ? (i > 40 ? "backfilled" : "exact") : null,
      });
    add("claude", "claude-opus-5-5", 42e6 * k, 18.4);
    if (i % 3 === 0) add("claude", "claude-sonnet-5-5", 8e6 * k, 1.9);
    add("openai", "gpt-6.1-sol", 30e6 * k, 6.2);
  }
  const t = Math.floor(Date.now() / 1000);
  return {
    rows,
    codex: {
      plan: "plus",
      windows: [
        { key: "five_hour", used_percent: 0, resets_at: t + 3 * 3600, window_minutes: 300 },
        { key: "seven_day", used_percent: 60, resets_at: t + 3 * 86400, window_minutes: 10080 },
      ],
      observed_at: Date.now() - 8 * 60000,
    },
    claude_hits: [],
    claude_statusline: {
      connected: true,
      has_other: false,
      windows: [
        { key: "five_hour", used_percent: 0, resets_at: t + 7200, window_minutes: 300 },
        { key: "seven_day", used_percent: 96, resets_at: t + 4 * 86400, window_minutes: 10080 },
      ],
      observed_at: Date.now() - 3 * 60_000,
    },
    claude_plan: { organization_type: "claude_pro", rate_limit_tier: null, billing_type: null },
    generated_at: Date.now(),
  };
}

export function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const t = Math.floor(Date.now() / 1000);
  switch (cmd) {
    case "get_usage":
      return Promise.resolve(report(Boolean(args?.withCost)));
    case "connect_statusline":
    case "disconnect_statusline":
      return Promise.resolve({ connected: cmd === "connect_statusline", has_other: false, windows: [], observed_at: null });
    case "refresh_prices":
      return Promise.resolve<PriceStatus>({
        last_checked: Date.now() - 3600_000,
        snapshots: 2,
        latest_effective_from: Date.now() - 3600_000,
        changed: false,
        error: null,
      });
    case "get_public_ip":
      return Promise.resolve({ ip: "203.0.113.42", country: "US", source: "cloudflare", region: args?.lang === "en" ? "California" : "加利福尼亚州", city: "圣荷西", fetched_at: Date.now(), error: null });
    case "check_network":
      return Promise.resolve(
        args?.service === "claude"
          ? { service: "claude", ip: "203.0.113.42", country: "SG", latency_ms: 324, trust_score: 94, restricted: false, ip_kind: "residential", checked_at: Date.now(), error: null }
          : { service: "openai", ip: "203.0.113.42", country: "SG", latency_ms: 612, trust_score: 41, restricted: false, ip_kind: "datacenter", checked_at: Date.now(), error: null },
      );
    case "get_claude_cli_usage":
      return Promise.resolve({
        windows: [
          { key: "five_hour", used_percent: 38, resets_at: t + 7200, window_minutes: 300 },
          { key: "seven_day", used_percent: 52, resets_at: t + 3 * 86400, window_minutes: 10080 },
          { key: "seven_day_fable", used_percent: 12, resets_at: t + 3 * 86400, window_minutes: 10080 },
        ],
        fetched_at: Date.now() - 3 * 60_000,
        error: null,
      });
    case "open_task":
      // Demo: the conversation was deleted.
      return Promise.reject("not_found");
    case "get_activity":
      return Promise.resolve({
        claude: 2,
        codex: 1,
        claude_tasks: [
          { id: "c1", title: "修复登录页在手机上的布局", started_at: Date.now() - 4 * 60_000 - 12_000, created_at: Date.now() - 26 * 3600_000, openable: true },
          { id: "c2", title: "Write release notes for v2.4 and update the changelog", started_at: Date.now() - 47_000, created_at: Date.now() - 2 * 3600_000, openable: false },
        ],
        codex_tasks: [{ id: "x1", title: "优化首页间距适配响应式", started_at: Date.now() - 12 * 60_000, created_at: Date.now() - 40 * 60_000, openable: true }],
      });
    case "get_claude_quota":
      return Promise.resolve<QuotaResult>({
        windows: [
          { key: "five_hour", used_percent: 74, resets_at: t + 5400, window_minutes: 300 },
          { key: "seven_day", used_percent: 93, resets_at: t + 2 * 86400, window_minutes: 10080 },
        ],
        fetched_at: Date.now() - 25 * 60_000,
        error: args?.force ? null : "rate_limited",
        retry_at: args?.force ? null : Date.now() + 12 * 60_000,
      });
  }
  return Promise.reject(new Error("unknown command " + cmd));
}
