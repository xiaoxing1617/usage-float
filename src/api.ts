import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";

/** In a plain browser during development, use fake data so the UI can be previewed. */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (import.meta.env.DEV && !isTauri()) {
    const { mockInvoke } = await import("./mock");
    return (await mockInvoke(cmd, args)) as T;
  }
  return tauriInvoke<T>(cmd, args);
}

export type ProviderId = "claude" | "openai";

export interface DailyRow {
  date: string;
  provider: ProviderId;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
  price_quality: "exact" | "backfilled" | "approximate" | null;
}

export interface QuotaWindow {
  key: string;
  used_percent: number;
  resets_at: number | null; // unix seconds
  window_minutes: number | null;
}

export interface CodexLimits {
  plan: string | null;
  windows: QuotaWindow[];
  observed_at: number | null; // unix ms
}

export interface ClaudeLimitHit {
  kind: string;
  resets_at: number; // unix seconds
  observed_at: number; // unix ms
}

export interface QuotaResult {
  windows: QuotaWindow[];
  fetched_at: number | null; // unix ms
  error: string | null;
  retry_at: number | null; // unix ms
}

export interface StatuslineState {
  connected: boolean;
  has_other: boolean;
  windows: QuotaWindow[];
  observed_at: number | null; // unix ms
}

export interface ClaudePlan {
  organization_type: string | null;
  rate_limit_tier: string | null;
  billing_type: string | null;
}

export interface UsageReport {
  rows: DailyRow[];
  codex: CodexLimits | null;
  claude_hits: ClaudeLimitHit[];
  claude_statusline: StatuslineState;
  claude_plan: ClaudePlan;
  generated_at: number;
}

export interface PriceStatus {
  last_checked: number | null;
  snapshots: number;
  latest_effective_from: number | null;
  changed: boolean;
  error: string | null;
}

export const getUsage = (withCost: boolean) => invoke<UsageReport>("get_usage", { withCost });
export const refreshPrices = (force: boolean) => invoke<PriceStatus>("refresh_prices", { force });
export const getClaudeQuota = (force: boolean) => invoke<QuotaResult>("get_claude_quota", { force });

/** Claude quota from Claude Code's own `/usage` command. */
export interface CliUsage {
  windows: QuotaWindow[];
  fetched_at: number | null; // unix ms
  error: string | null;
}
export const getClaudeCliUsage = (force: boolean) => invoke<CliUsage>("get_claude_cli_usage", { force });

/** Conversations running right now in Claude Code / Codex on this Mac. */
export interface RunningTask {
  id: string;
  title: string | null;
  started_at: number | null; // unix ms
  created_at: number | null; // unix ms
  openable: boolean;
}
export interface Activity {
  claude: number;
  codex: number;
  claude_tasks: RunningTask[];
  codex_tasks: RunningTask[];
}
export const getActivity = () => invoke<Activity>("get_activity");
export interface IpInfo {
  ip: string | null;
  country: string | null;
  source: string | null;
  region: string | null;
  city: string | null;
  fetched_at: number;
  error: string | null;
}
export const getPublicIp = (lang: string) => invoke<IpInfo>("get_public_ip", { lang });

/** City-states, where the "region" is only a district: show the country alone. */
const CITY_STATES = new Set(["SG", "HK", "MO", "MC", "VA"]);
export const showRegion = (cc: string | null) => !cc || !CITY_STATES.has(cc);

let toTw: ((s: string) => string) | null = null;
/** Simplified -> Traditional (Taiwan) for place names; loaded only when needed. */
export async function toTraditional(text: string): Promise<string> {
  if (!toTw) {
    const { Converter } = await import("opencc-js/cn2t");
    toTw = Converter({ from: "cn", to: "tw" });
  }
  return toTw(text);
}

/** "SG" -> 🇸🇬 */
export const flagOf = (cc: string | null) =>
  cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";

export interface NetCheck {
  service: ProviderId;
  ip: string | null;
  country: string | null;
  latency_ms: number | null;
  trust_score: number | null;
  restricted: boolean;
  ip_kind: string | null;
  checked_at: number;
  error: string | null;
}
export const checkNetwork = (service: ProviderId, force: boolean) => invoke<NetCheck>("check_network", { service, force });

/** Colour on ip.net.coffee's gauge: red (0) → orange → yellow → green → dark green (100). */
const STOPS: [number, [number, number, number]][] = [
  [0, [0xc0, 0x39, 0x2b]],
  [25, [0xe1, 0x70, 0x55]],
  [50, [0xf0, 0xc0, 0x40]],
  [75, [0x6f, 0xcf, 0x7c]],
  [100, [0x1b, 0x8a, 0x2d]],
];
export function scoreColor(score: number): { bg: string; fg: string } {
  const s = Math.max(0, Math.min(100, score));
  let i = 0;
  while (i < STOPS.length - 2 && s > STOPS[i + 1][0]) i++;
  const [a, ca] = STOPS[i];
  const [b, cb] = STOPS[i + 1];
  const k = (s - a) / (b - a);
  const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
  const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  return { bg: `rgb(${c.join(",")})`, fg: lum > 0.6 ? "#1c1c1f" : "#fff" };
}
export type ScoreLevel = "excellent" | "clean" | "good" | "neutral" | "suspicious";
export const scoreLevel = (s: number): ScoreLevel =>
  s >= 95 ? "excellent" : s >= 80 ? "clean" : s >= 50 ? "good" : s >= 25 ? "neutral" : "suspicious";
export type LatencyLevel = "fast" | "ok" | "slow";
export const latencyLevel = (ms: number): LatencyLevel => (ms < 250 ? "fast" : ms < 500 ? "ok" : "slow");

/** Localised country/region name for an ISO code, e.g. ("SG", "zh-SG") -> "新加坡". */
export function regionName(cc: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
}

export const connectStatusline = () => invoke<StatuslineState>("connect_statusline");
export const disconnectStatusline = () => invoke<StatuslineState>("disconnect_statusline");

export interface ClaudeQuotaView {
  windows: QuotaWindow[];
  /** Where the windows came from, and when (unix ms). */
  source: "statusline" | "cli" | "api" | "logs" | null;
  at: number | null;
}

/**
 * Merges the quota endpoint result with limit hits from local Claude Code logs:
 * a hit newer than the fetched data means that window is used up until it resets.
 */
export function effectiveClaudeWindows(
  q: QuotaResult | null,
  sl: StatuslineState | null | undefined,
  cli: CliUsage | null,
  hits: ClaudeLimitHit[],
  nowMs: number,
): ClaudeQuotaView {
  // Use whichever source is freshest: /usage, the status line, or the endpoint.
  const candidates: [NonNullable<ClaudeQuotaView["source"]>, number | null, QuotaWindow[]][] = [
    ["cli", cli?.fetched_at ?? null, cli?.windows ?? []],
    ["statusline", sl?.observed_at ?? null, sl?.windows ?? []],
    ["api", q?.fetched_at ?? null, q?.windows ?? []],
  ];
  let source: ClaudeQuotaView["source"] = null;
  let at: number | null = null;
  let base: QuotaWindow[] = [];
  for (const [src, t, ws] of candidates) {
    if (!ws.length) continue;
    if (source == null || (t ?? 0) > (at ?? 0)) [source, at, base] = [src, t, ws];
  }
  const out = base.map((w) => ({ ...w }));
  for (const h of hits) {
    if (h.resets_at * 1000 <= nowMs) continue;
    if (at && at >= h.observed_at) continue;
    if (!source) [source, at] = ["logs", h.observed_at];
    const w = out.find((x) => x.key === h.kind);
    if (w) {
      w.used_percent = 100;
      w.resets_at = h.resets_at;
    } else {
      out.push({ key: h.kind, used_percent: 100, resets_at: h.resets_at, window_minutes: null });
    }
  }
  return { windows: out.sort((a, b) => order(a.key) - order(b.key)), source, at };
}
const order = (k: string) => (k === "five_hour" ? 0 : k === "seven_day" ? 1 : 2);

export function claudePlanLabel(p: ClaudePlan): string | null {
  const t = (p.organization_type || "").replace(/^claude_/, "");
  if (!t) return null;
  const tier = p.rate_limit_tier || "";
  const mult = tier.match(/(\d+)x/);
  const name = t.charAt(0).toUpperCase() + t.slice(1);
  return t === "max" && mult ? `${name} ${mult[1]}x` : name;
}

export function codexPlanLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}
