import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  claudePlanLabel,
  codexPlanLabel,
  connectStatusline,
  disconnectStatusline,
  effectiveClaudeWindows,
  getClaudeQuota,
  getPublicIp,
  toTraditional,
  showRegion,
  checkNetwork,
  scoreColor,
  scoreLevel,
  latencyLevel,
  type NetCheck,
  flagOf,
  regionName,
  type IpInfo,
  getUsage,
  refreshPrices,
  type DailyRow,
  type PriceStatus,
  type ClaudeQuotaView,
  type ProviderId,
  type QuotaResult,
  type StatuslineState,
  type QuotaWindow,
  type UsageReport,
} from "./api";
import { CURRENCIES, formatMoney, loadRates, type Currency, type Rates } from "./currency";
import { DICTS, LANGS, detectLang, fmt, intlLocale, type Dict, type Lang } from "./i18n";
import { PERIODS, daysIn, rangeFor, ymd, type PeriodId, type Range } from "./periods";
import "./App.css";

// ---------- settings (per-viewer convenience; safe defaults if storage fails) ----------

interface Settings {
  lang: Lang;
  currency: Currency;
  autoPrices: boolean;
  claudeQuota: boolean;
  alwaysOnTop: boolean;
  showIp: boolean;
  netCheck: boolean;
  weekStart: 0 | 1;
  period: PeriodId;
  custom: Range;
  /** full panel, slim bars, or a small floating ball */
  mode: Mode;
}

type Mode = "full" | "ball";

const SETTINGS_KEY = "uf.settings";

function loadSettings(): Settings {
  const today = ymd(new Date());
  const defaults: Settings = {
    lang: detectLang(),
    currency: "USD",
    autoPrices: false,
    claudeQuota: false,
    alwaysOnTop: true,
    showIp: true,
    netCheck: true,
    weekStart: 1,
    period: "today",
    custom: { start: today, end: today },
    mode: "full",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (saved.mode === "compact") saved.mode = "full"; // compact view was removed
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

// ---------- formatting ----------

function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "K";
  return String(n);
}

function duration(ms: number, t: Dict): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return t.ago_s;
  if (m < 60) return fmt(t.ago_m, { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) {
    const rm = m % 60;
    return fmt(t.ago_h, { n: h }) + (rm && h < 10 ? " " + fmt(t.ago_m, { n: rm }) : "");
  }
  return fmt(t.ago_d, { n: Math.round(h / 24) });
}

const totalTokens = (r: DailyRow) => r.input + r.output + r.cache_read + r.cache_write;

// ---------- app ----------

const SIZES: Record<Mode, [number, number]> = {
  full: [340, 620],
  ball: [108, 108],
};
const CLAUDE_POLL_MS = 10 * 60_000;

export default function App() {
  const [s, setS] = useState<Settings>(loadSettings);
  const t = DICTS[s.lang];
  const locale = intlLocale(s.lang);
  const update = (patch: Partial<Settings>) =>
    setS((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });

  const [view, setView] = useState<"main" | "settings">("main");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [prices, setPrices] = useState<PriceStatus | null>(null);
  const [pricesBusy, setPricesBusy] = useState(false);
  const [claudeQuota, setClaudeQuota] = useState<QuotaResult | null>(null);
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [slBusy, setSlBusy] = useState(false);
  const [slError, setSlError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const withCost = s.autoPrices && (prices?.snapshots ?? 0) > 0;

  // Usage: rescans changed log files only, so refreshing every minute is cheap.
  const loadUsage = useCallback(async () => {
    try {
      setReport(await getUsage(withCost));
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }, [withCost]);
  useEffect(() => {
    loadUsage();
    const id = setInterval(loadUsage, 60_000);
    return () => clearInterval(id);
  }, [loadUsage]);

  // Prices: the backend only downloads when the last check is 12+ hours old.
  const checkPrices = useCallback(async (force: boolean) => {
    setPricesBusy(true);
    try {
      setPrices(await refreshPrices(force));
    } finally {
      setPricesBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!s.autoPrices) return;
    checkPrices(false);
    const id = setInterval(() => checkPrices(false), 30 * 60_000);
    return () => clearInterval(id);
  }, [s.autoPrices, checkPrices]);

  // Exchange rates (cached 12 h).
  useEffect(() => {
    loadRates().then(setRates);
    const id = setInterval(() => loadRates().then(setRates), 60 * 60_000);
    return () => clearInterval(id);
  }, []);

  // Claude quota (unofficial endpoint), only when the user opted in.
  // Polls every 10 min; when rate limited, waits until the backend's retry time.
  const claudeTimer = useRef<number | undefined>(undefined);
  const loadClaudeQuota = useCallback(async (force: boolean) => {
    window.clearTimeout(claudeTimer.current);
    setClaudeBusy(true);
    let next = CLAUDE_POLL_MS;
    try {
      const r = await getClaudeQuota(force);
      setClaudeQuota(r);
      if (r.retry_at) next = Math.max(60_000, r.retry_at - Date.now() + 5_000);
    } catch (e) {
      setClaudeQuota((prev) => ({ windows: prev?.windows ?? [], fetched_at: prev?.fetched_at ?? null, error: String(e), retry_at: null }));
    } finally {
      setClaudeBusy(false);
    }
    claudeTimer.current = window.setTimeout(() => loadClaudeQuota(false), next);
  }, []);
  useEffect(() => {
    if (!s.claudeQuota) {
      window.clearTimeout(claudeTimer.current);
      setClaudeQuota(null);
      return;
    }
    loadClaudeQuota(false);
    return () => window.clearTimeout(claudeTimer.current);
  }, [s.claudeQuota, loadClaudeQuota]);

  // Clock for countdowns.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Window behaviour.
  useEffect(() => {
    if (isTauri()) getCurrentWindow().setAlwaysOnTop(s.alwaysOnTop).catch(() => {});
  }, [s.alwaysOnTop]);
  useEffect(() => {
    if (!isTauri()) return;
    const [width, height] = SIZES[s.mode];
    invoke("resize_on_screen", { width, height }).catch(() => {});
  }, [s.mode]);

  useEffect(() => {
    document.documentElement.lang = s.lang;
  }, [s.lang]);

  const money = (usd: number) => (rates ? formatMoney(usd, s.currency, rates, locale) : "…");

  const [ip, setIp] = useState<IpInfo | null>(null);
  const [ipBusy, setIpBusy] = useState(false);
  const loadIp = useCallback(async () => {
    setIpBusy(true);
    try {
      const r = await getPublicIp(s.lang);
      if (s.lang === "zh-Hant") {
        if (r.region) r.region = await toTraditional(r.region);
        if (r.city) r.city = await toTraditional(r.city);
      }
      setIp(r);
    } catch (e) {
      setIp({ ip: null, country: null, source: null, region: null, city: null, fetched_at: Date.now(), error: String(e) });
    } finally {
      setIpBusy(false);
    }
  }, [s.lang]);
  useEffect(() => {
    if (!s.showIp) return;
    loadIp();
    const id = setInterval(loadIp, 5 * 60_000);
    return () => clearInterval(id);
  }, [s.showIp, loadIp]);

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [net, setNet] = useState<Partial<Record<ProviderId, NetCheck | "busy">>>({});
  const runNet = useCallback(async (service: ProviderId, force: boolean) => {
    setNet((n) => ({ ...n, [service]: n[service] && n[service] !== "busy" ? n[service] : "busy" }));
    try {
      const r = await checkNetwork(service, force);
      setNet((n) => ({ ...n, [service]: r }));
    } catch {
      setNet((n) => ({ ...n, [service]: undefined }));
    }
  }, []);
  useEffect(() => {
    if (!s.netCheck) return;
    const all = () => (["claude", "openai"] as const).forEach((p) => runNet(p, false));
    all();
    const id = setInterval(all, 10 * 60_000);
    return () => clearInterval(id);
  }, [s.netCheck, runNet]);

  const refreshAll = () => {
    loadUsage();
    if (s.showIp) loadIp();
    if (s.netCheck) (["claude", "openai"] as const).forEach((p) => runNet(p, false));
  };

  const claudeView = effectiveClaudeWindows(claudeQuota, report?.claude_statusline, report?.claude_hits ?? [], now);
  const claudeWindows = claudeView.windows;
  const setStatusline = async (connect: boolean) => {
    setSlBusy(true);
    setSlError(null);
    try {
      await (connect ? connectStatusline() : disconnectStatusline());
      await loadUsage();
    } catch (e) {
      setSlError(String(e));
    } finally {
      setSlBusy(false);
    }
  };
  const setMode = (mode: Mode) => {
    setView("main");
    setDrawer(null);
    update({ mode });
  };

  if (s.mode === "ball") {
    return (
      <Ball
        t={t}
        claude={claudeWindows}
        gpt={report?.codex?.windows ?? []}
        now={now}
        onOpen={() => setMode("full")}
      />
    );
  }


  return (
    <div className="shell">
      {drawer && (
        <Drawer
          t={t}
          state={drawer}
          locale={locale}
          r={net[drawer.provider]}
          now={now}
          onClose={() => setDrawer(null)}
          onRecheck={() => runNet(drawer.provider, true)}
        />
      )}
      <header className="titlebar" data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>
          <button className="traffic" title={t.hide} aria-label={t.hide} onClick={() => { setDrawer(null); if (isTauri()) getCurrentWindow().hide(); }}>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
            </svg>
          </button>
          {t.appName}
        </span>
        <span className="actions">
          {view === "main" && (
            <button className="tbtn" title={t.refresh} onClick={refreshAll}>
              <span className="ico">↻</span>
              {t.refresh}
            </button>
          )}
          <button className="tbtn" onClick={() => setView(view === "main" ? "settings" : "main")}>
            <span className="ico">{view === "main" ? "⚙" : "←"}</span>
            {view === "main" ? t.settings : t.back}
          </button>
          <button className="tbtn" title={t.ball} onClick={() => setMode("ball")}>
            <span className="ico">●</span>
            {t.ballShort}
          </button>
        </span>
      </header>

      {view === "settings" ? (
        <SettingsView
          t={t}
          s={s}
          update={update}
          prices={prices}
          pricesBusy={pricesBusy}
          onFetchPrices={() => checkPrices(true)}
          rates={rates}
          locale={locale}
          sl={report?.claude_statusline ?? null}
          slBusy={slBusy}
          slError={slError}
          onStatusline={setStatusline}
        />
      ) : (
        <main className="scroll">
          {loadError && <div className="error">{loadError}</div>}
          {s.showIp && (
            <button
              className="iprow"
              title={[ip?.ip && ip.country ? [flagOf(ip.country), regionName(ip.country, locale), ip.region, ip.city].filter(Boolean).join(" ") : "", t.ipHint].filter(Boolean).join("\n")}
              onClick={loadIp}
              disabled={ipBusy}
            >
              <span className="muted">{t.ipLabel}</span>
              {ip?.ip ? (
                <>
                  <span className="ipaddr">{ip.ip}</span>
                  {ip.country && (
                    <span className="muted iploc">
                      {flagOf(ip.country)} {regionName(ip.country, locale)}
                      {ip.region && showRegion(ip.country) ? ` · ${ip.region}` : ""}
                    </span>
                  )}
                </>
              ) : (
                <span className="muted">{ip ? t.ipFail : "…"}</span>
              )}
              <span className={"ipspin" + (ipBusy ? " on" : "")}>↻</span>
            </button>
          )}
          <QuotaCard
            provider="claude"
            name="Claude"
            net={s.netCheck && <NetBadge t={t} r={net.claude} onScore={() => setDrawer({ kind: "site", provider: "claude" })} onLatency={() => setDrawer({ kind: "latency", provider: "claude" })} />}
            plan={report ? claudePlanLabel(report.claude_plan) : null}
            t={t}
            now={now}
            windows={claudeWindows}
            body={
              <ClaudeSources
                t={t}
                now={now}
                view={claudeView}
                sl={report?.claude_statusline ?? null}
                endpointOn={s.claudeQuota}
                quota={claudeQuota}
                busy={claudeBusy}
                slBusy={slBusy}
                slError={slError}
                onRetry={() => loadClaudeQuota(true)}
                onConnect={() => setStatusline(true)}
                onUseEndpoint={() => update({ claudeQuota: true })}
              />
            }
          />
          <QuotaCard
            provider="openai"
            name="GPT"
            net={s.netCheck && <NetBadge t={t} r={net.openai} onScore={() => setDrawer({ kind: "site", provider: "openai" })} onLatency={() => setDrawer({ kind: "latency", provider: "openai" })} />}
            plan={codexPlanLabel(report?.codex?.plan)}
            t={t}
            now={now}
            windows={report?.codex?.windows}
            body={
              !report?.codex ? (
                <div className="muted small">{t.codexNone}</div>
              ) : report.codex.observed_at ? (
                <div className="muted small">
                  {fmt(t.codexFrom, { t: duration(now - report.codex.observed_at, t) })}
                </div>
              ) : null
            }
          />
          <Stats t={t} s={s} update={update} report={report} withCost={withCost} money={money} />
          <footer className="muted small foot">
            {report && fmt(t.updated, { t: new Date(report.generated_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })}
          </footer>
        </main>
      )}
    </div>
  );
}

function quotaError(code: string, t: Dict): string {
  const key = ("err_" + code) as keyof Dict;
  return key in t ? t[key] : fmt(t.err_other, { e: code });
}

// ---------- quota ----------

function windowLabel(key: string, t: Dict) {
  const k = ("win_" + key) as keyof Dict;
  return k in t ? t[k] : t.win_other;
}

function QuotaBar({ w, t, now }: { w: QuotaWindow; t: Dict; now: number }) {
  const expired = w.resets_at != null && w.resets_at * 1000 <= now;
  const used = expired ? 0 : Math.min(100, Math.max(0, w.used_percent));
  const left = Math.round(100 - used);
  const level = left <= 10 ? "crit" : left <= 30 ? "low" : "ok";
  return (
    <div className="qrow">
      <div className="qhead">
        <span>{windowLabel(w.key, t)}</span>
        <span className={"qleft " + level}>{fmt(t.remaining, { p: left })}</span>
      </div>
      <div className="bar">
        <div className={"fill " + level} style={{ width: `${left}%` }} />
      </div>
      {w.resets_at != null && (
        <div className="muted tiny">
          {expired ? t.resetDone : fmt(t.resetsIn, { t: duration(w.resets_at * 1000 - now, t) })}
        </div>
      )}
    </div>
  );
}

const SITE: Record<ProviderId, string> = {
  claude: "https://ip.net.coffee/claude/",
  openai: "https://ip.net.coffee/gpt/",
};
const TRACE: Record<ProviderId, string> = {
  claude: "https://claude.ai/cdn-cgi/trace",
  openai: "https://chatgpt.com/cdn-cgi/trace",
};
const PNAME: Record<ProviderId, string> = { claude: "Claude", openai: "GPT" };

type DrawerState = { kind: "site" | "latency"; provider: ProviderId } | null;

const Shield = () => (
  <svg className="shield" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 .8 1.6 2.4v3.2c0 2.7 1.9 4.7 4.4 5.6 2.5-.9 4.4-2.9 4.4-5.6V2.4z" />
    <path className="tick" d="M3.9 6.1 5.4 7.5 8.2 4.6" />
  </svg>
);

function NetBadge(props: {
  t: Dict;
  r: NetCheck | "busy" | undefined;
  onScore: () => void;
  onLatency: () => void;
}) {
  const { t, r, onScore, onLatency } = props;
  if (!r) return null;
  if (r === "busy") return <span className="net muted">…</span>;
  let scoreEl: React.ReactNode = null;
  if (r.trust_score != null) {
    const c = scoreColor(r.trust_score);
    const lv = r.restricted ? t.netRestricted : (t[`lv_${scoreLevel(r.trust_score)}` as keyof Dict] as string);
    const tip = `${t.trust} ${r.trust_score} · ${lv}\n${t.scoreClick}`;
    scoreEl = (
      <button className="score" style={{ background: c.bg, color: c.fg }} title={tip} aria-label={tip} onClick={onScore}>
        <Shield />
        {r.trust_score}
      </button>
    );
  }
  const latTip = t.latClick;
  const latEl =
    r.latency_ms == null ? (
      <button className="lat slow" title={latTip} onClick={onLatency}>
        {t.netDown}
      </button>
    ) : (
      <button className={"lat " + latencyLevel(r.latency_ms)} title={latTip} onClick={onLatency}>
        {r.latency_ms}ms
      </button>
    );
  return (
    <span className="net">
      {scoreEl}
      {latEl}
    </span>
  );
}

function Drawer(props: {
  t: Dict;
  state: NonNullable<DrawerState>;
  locale: string;
  r: NetCheck | "busy" | undefined;
  now: number;
  onClose: () => void;
  onRecheck: () => void;
}) {
  const { t, state, r, now, onClose, onRecheck, locale } = props;
  const name = PNAME[state.provider];
  const body = useRef<HTMLDivElement>(null);
  const url = SITE[state.provider];

  // The site cannot be iframed, so a native child webview is placed over the body.
  useEffect(() => {
    if (state.kind !== "site" || !isTauri()) return;
    const timer = setTimeout(() => {
      const el = body.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      invoke("open_site", { url, x: rect.left, y: rect.top, width: rect.width, height: rect.height }).catch(() => {});
    }, 220); // after the slide-in animation
    return () => {
      clearTimeout(timer);
      invoke("close_site").catch(() => {});
    };
  }, [state.kind, url]);

  const openExternal = () => {
    if (isTauri()) openUrl(url).catch(() => {});
    else window.open(url, "_blank");
  };

  const res = r && r !== "busy" ? r : null;
  return (
    <div className="drawer" role="dialog" aria-label={state.kind === "site" ? fmt(t.siteTitle, { name }) : fmt(t.latTitle, { name })}>
      <div className="drawerhead">
        <button className="tbtn" onClick={onClose}>
          <span className="ico">‹</span>
          {t.back}
        </button>
        <span className="drawertitle">{state.kind === "site" ? fmt(t.siteTitle, { name }) : fmt(t.latTitle, { name })}</span>
        {state.kind === "site" ? (
          <button className="tbtn" title={t.openInBrowser} onClick={openExternal}>
            <span className="ico">↗</span>
          </button>
        ) : (
          <span style={{ width: 28 }} />
        )}
      </div>
      {state.kind === "site" ? (
        <div className="drawerbody site" ref={body}>
          {!isTauri() && <div className="muted small empty">{t.siteOnlyInApp}</div>}
        </div>
      ) : (
        <div className="drawerbody latency">
          <div className="latbig">
            {res?.latency_ms != null ? (
              <>
                <span className={"lat " + latencyLevel(res.latency_ms)}>{res.latency_ms}ms</span>
                <span className="muted">{t[`lat_${latencyLevel(res.latency_ms)}` as keyof Dict] as string}</span>
              </>
            ) : (
              <span className="lat slow">{r === "busy" ? "…" : t.netDown}</span>
            )}
          </div>
          <dl className="facts">
            <dt>{t.latUrl}</dt>
            <dd>
              <code>GET {TRACE[state.provider]}</code>
            </dd>
            <dt>{t.latMethod}</dt>
            <dd>{t.latMethodText}</dd>
            <dt>{t.latScale}</dt>
            <dd className="scale">
              <span><i className="d fast" />&lt; 250ms {t.lat_fast}</span>
              <span><i className="d ok" />&lt; 500ms {t.lat_ok}</span>
              <span><i className="d slow" />≥ 500ms {t.lat_slow}</span>
            </dd>
            {res?.ip && (
              <>
                <dt>{t.netEgress}</dt>
                <dd>
                  {res.ip} {res.country && `${flagOf(res.country)} ${regionName(res.country, locale)}`}
                </dd>
              </>
            )}
            {res && (
              <>
                <dt>{t.checkedAt}</dt>
                <dd>{now - res.checked_at < 60_000 ? t.ago_s : fmt(t.agoFmt, { t: duration(now - res.checked_at, t) })}</dd>
              </>
            )}
          </dl>
          <button className="btn primary" onClick={onRecheck} disabled={r === "busy"}>
            {t.recheck}
          </button>
        </div>
      )}
    </div>
  );
}

function QuotaCard(props: {
  provider: ProviderId;
  name: string;
  plan: string | null;
  t: Dict;
  now: number;
  windows?: QuotaWindow[];
  body?: React.ReactNode;
  net?: React.ReactNode;
}) {
  const { provider, name, plan, t, now, windows, body, net } = props;
  return (
    <section className={"card " + provider}>
      <div className="cardhead">
        <span className="pname">
          <span className={"swatch " + provider} />
          {name}
          {net}
        </span>
        <span className={"badge" + (plan ? "" : " unknown")}>{plan ?? t.planUnknown}</span>
      </div>
      {windows?.map((w) => <QuotaBar key={w.key} w={w} t={t} now={now} />)}
      {body}
    </section>
  );
}

// ---------- claude data sources ----------

function ClaudeSources(props: {
  t: Dict;
  now: number;
  view: ClaudeQuotaView;
  sl: StatuslineState | null;
  endpointOn: boolean;
  quota: QuotaResult | null;
  busy: boolean;
  slBusy: boolean;
  slError: string | null;
  onRetry: () => void;
  onConnect: () => void;
  onUseEndpoint: () => void;
}) {
  const { t, now, view, sl, endpointOn, quota, busy, slBusy, slError, onRetry, onConnect, onUseEndpoint } = props;
  const ago = (ms: number | null) => duration(now - (ms ?? now), t);
  const source =
    view.source === "statusline"
      ? fmt(t.slFrom, { t: ago(view.at) })
      : view.source === "api"
        ? fmt(t.apiFrom, { t: ago(view.at) })
        : view.source === "logs"
          ? t.logsFrom
          : null;
  // Endpoint errors only matter when the endpoint is the best source we have.
  const showApiError = endpointOn && quota?.error && view.source !== "statusline";
  const connected = sl?.connected ?? false;
  return (
    <>
      {source && <div className="muted tiny">{source}</div>}
      {connected && !sl?.windows.length && <div className="muted tiny">{t.slWaiting}</div>}
      {showApiError && (
        <div className="qerr">
          <div className="warn small">{quotaError(quota!.error!, t)}</div>
          {quota!.retry_at && <div className="muted tiny">{fmt(t.autoRetry, { t: duration(quota!.retry_at - now, t) })}</div>}
          <button className="btn" disabled={busy} onClick={onRetry}>
            {busy ? "…" : t.retry}
          </button>
        </div>
      )}
      {!connected && (
        <div className="qerr">
          {!endpointOn && !view.source && <div className="muted small">{t.claudeQuotaOff}</div>}
          <button className="btn primary" disabled={slBusy} title={t.slHint} onClick={onConnect}>
            {slBusy ? "…" : t.slConnect}
          </button>
          {!endpointOn && (
            <button className="link tiny" title={t.claudeQuotaHint} onClick={onUseEndpoint}>
              {t.claudeQuotaEnable}
            </button>
          )}
        </div>
      )}
      {slError && <div className="warn tiny">{fmt(t.slError, { e: slError })}</div>}
    </>
  );
}

// ---------- floating ball ----------

/** Remaining % (0-100) for a window key, null if unknown. */
function leftFor(ws: QuotaWindow[], key: string, now: number): number | null {
  const w = ws.find((x) => x.key === key);
  if (!w) return null;
  const expired = w.resets_at != null && w.resets_at * 1000 <= now;
  return Math.round(100 - (expired ? 0 : Math.min(100, Math.max(0, w.used_percent))));
}

const lvl = (p: number | null) => (p == null ? "" : p <= 10 ? "crit" : p <= 30 ? "low" : "ok");

/**
 * Round widget: left half = Claude, right half = GPT.
 * Each half: "5h" caption, big 5-hour remaining %, weekly remaining underneath.
 * The ring halves fill from the bottom by the 5-hour remaining.
 */
function Ball(props: { t: Dict; claude: QuotaWindow[]; gpt: QuotaWindow[]; now: number; onOpen: () => void }) {
  const { t, claude, gpt, now, onOpen } = props;
  const sides = [
    { id: "claude" as const, name: "Claude", h5: leftFor(claude, "five_hour", now), wk: leftFor(claude, "seven_day", now) },
    { id: "openai" as const, name: "GPT", h5: leftFor(gpt, "five_hour", now), wk: leftFor(gpt, "seven_day", now) },
  ];

  // Click opens the panel; dragging past a few pixels moves the window instead.
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    start.current = { x: e.screenX, y: e.screenY };
    dragged.current = false;
  };
  const onMove = (e: React.MouseEvent) => {
    if (!start.current || dragged.current) return;
    if (Math.hypot(e.screenX - start.current.x, e.screenY - start.current.y) > 3) {
      dragged.current = true;
      start.current = null;
      if (isTauri()) getCurrentWindow().startDragging().catch(() => {});
    }
  };
  const onUp = () => {
    if (start.current && !dragged.current) onOpen();
    start.current = null;
  };

  // Two concentric half rings per side, from 6 o'clock up to 12 o'clock:
  // outer (thick) = 5-hour remaining, inner (thin) = weekly remaining.
  const S = 100;
  const C = S / 2;
  const rings = [
    { key: "h5" as const, r: 46, cls: "ring" },
    { key: "wk" as const, r: 40, cls: "ring wkring" },
  ];
  const arc = (r: number, left: boolean) =>
    `M ${C} ${C + r} A ${r} ${r} 0 0 ${left ? 1 : 0} ${C} ${C - r}`;
  const pctText = (p: number | null) => (p == null ? "—" : `${p}%`);
  const tip = [
    t.ballHint,
    ...sides.map((x) => `${x.name}: 5h ${pctText(x.h5)} · ${t.win_seven_day} ${pctText(x.wk)}`),
  ].join("\n");

  return (
    <div className="ballwrap">
      <div
        className="ball"
        title={tip}
        role="button"
        aria-label={tip}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => (start.current = null)}
      >
        <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} aria-hidden="true">
          {sides.map((x, i) =>
            rings.map((g) => {
              const d = arc(g.r, i === 0);
              const len = Math.PI * g.r;
              const v = x[g.key];
              return (
                <g key={x.id + g.key} className={g.key === "wk" ? "wkg" : undefined}>
                  <path d={d} className={g.key === "wk" ? "ring-track thin" : "ring-track"} />
                  {v != null && v > 0 && (
                    <path d={d} className={`${g.cls} ${x.id} ${lvl(v)}`} strokeDasharray={`${(len * v) / 100} ${len}`} />
                  )}
                </g>
              );
            }),
          )}
        </svg>
        <div className="halves">
          {sides.map((x) => (
            <div key={x.id} className={"half " + x.id}>
              <span className="cap">5h</span>
              <span className={"num " + lvl(x.h5)}>
                {x.h5 == null ? "—" : x.h5}
                {x.h5 != null && <small>%</small>}
              </span>
              <span className={"wk " + lvl(x.wk)}>
                {t.ballWeek}
                <b>{x.wk == null ? "—" : `${x.wk}%`}</b>
              </span>
            </div>
          ))}
          <span className="divider" />
        </div>
      </div>
    </div>
  );
}

// ---------- stats ----------

interface Agg {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  approx: boolean;
}
const emptyAgg = (): Agg => ({ tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, approx: false });
function add(a: Agg, r: DailyRow) {
  a.tokens += totalTokens(r);
  a.input += r.input;
  a.output += r.output;
  a.cacheRead += r.cache_read;
  a.cacheWrite += r.cache_write;
  a.cost += r.cost_usd ?? 0;
  if (r.price_quality && r.price_quality !== "exact") a.approx = true;
}

function Stats(props: {
  t: Dict;
  s: Settings;
  update: (p: Partial<Settings>) => void;
  report: UsageReport | null;
  withCost: boolean;
  money: (usd: number) => string;
}) {
  const { t, s, update, report, withCost, money } = props;
  const range = rangeFor(s.period, s.weekStart, s.custom);
  const rows = useMemo(
    () => report?.rows.filter((r) => r.date >= range.start && r.date <= range.end) ?? [],
    [report, range.start, range.end],
  );

  const byProvider: Record<ProviderId, Agg> = { claude: emptyAgg(), openai: emptyAgg() };
  const total = emptyAgg();
  const byModel = new Map<string, Agg & { provider: ProviderId }>();
  const byDay = new Map<string, { claude: number; openai: number }>();
  for (const r of rows) {
    add(byProvider[r.provider], r);
    add(total, r);
    const m = byModel.get(r.model) ?? { ...emptyAgg(), provider: r.provider };
    add(m, r);
    byModel.set(r.model, m);
    const d = byDay.get(r.date) ?? { claude: 0, openai: 0 };
    d[r.provider] += withCost ? (r.cost_usd ?? 0) : totalTokens(r);
    byDay.set(r.date, d);
  }
  const models = [...byModel.entries()].sort((a, b) => (withCost ? b[1].cost - a[1].cost : b[1].tokens - a[1].tokens));
  const days = daysIn(range);
  const showChart = days.length > 1;
  const max = Math.max(1e-9, ...days.map((d) => (byDay.get(d)?.claude ?? 0) + (byDay.get(d)?.openai ?? 0)));

  return (
    <section className="card stats">
      <div className="chips">
        {PERIODS.map((p) => (
          <button key={p} className={"chip" + (s.period === p ? " on" : "")} onClick={() => update({ period: p })}>
            {t[("p_" + p) as keyof Dict]}
          </button>
        ))}
      </div>
      {s.period === "custom" && (
        <div className="custom">
          <label>
            {t.from}
            <input
              type="date"
              value={s.custom.start}
              onChange={(e) => update({ custom: { ...s.custom, start: e.target.value } })}
            />
          </label>
          <label>
            {t.to}
            <input type="date" value={s.custom.end} onChange={(e) => update({ custom: { ...s.custom, end: e.target.value } })} />
          </label>
        </div>
      )}
      <div className="muted tiny range">
        {range.start === range.end ? range.start : `${range.start} → ${range.end}`}
      </div>

      <div className="sumrow">
        <span className="muted small">{t.total}</span>
        <span className="big">{withCost ? money(total.cost) : compact(total.tokens) + " " + t.tokens}</span>
        {withCost && <span className="muted tiny">{compact(total.tokens)} {t.tokens}</span>}
      </div>

      <div className="totals">
        {(["claude", "openai"] as ProviderId[]).map((p) => (
          <div key={p} className="tot">
            <div className="muted tiny">
              <span className={"swatch " + p} />
              {p === "claude" ? "Claude" : "GPT"}
            </div>
            <div className="big">{withCost ? money(byProvider[p].cost) : compact(byProvider[p].tokens)}</div>
            <div className="muted tiny">
              {withCost ? `${compact(byProvider[p].tokens)} ${t.tokens}` : t.tokens}
            </div>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="muted small empty">{t.noUsage}</div>
      ) : (
        <>
          <div className="split muted tiny">
            <span>
              {t.input} {compact(total.input)}
            </span>
            <span>
              {t.output} {compact(total.output)}
            </span>
            <span>
              {t.cacheRead} {compact(total.cacheRead)}
            </span>
            <span>
              {t.cacheWrite} {compact(total.cacheWrite)}
            </span>
          </div>

          {showChart && (
            <div className="chart" role="img" aria-label={t.daily}>
              {days.map((d) => {
                const v = byDay.get(d) ?? { claude: 0, openai: 0 };
                const tip = `${d}  Claude ${withCost ? money(v.claude) : compact(v.claude)} · GPT ${withCost ? money(v.openai) : compact(v.openai)}`;
                return (
                  <div key={d} className="col" title={tip}>
                    <div className="seg openai" style={{ height: `${(v.openai / max) * 100}%` }} />
                    <div className="seg claude" style={{ height: `${(v.claude / max) * 100}%` }} />
                  </div>
                );
              })}
            </div>
          )}

          <div className="sub muted tiny">{t.byModel}</div>
          <ul className="models">
            {models.map(([model, a]) => (
              <li key={model}>
                <span className={"swatch " + a.provider} />
                <span className="mname" title={model}>
                  {model}
                </span>
                <span className="mval">
                  {withCost ? (
                    <>
                      {money(a.cost)}
                      {a.approx && "*"} <span className="muted">· {compact(a.tokens)}</span>
                    </>
                  ) : (
                    compact(a.tokens)
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="muted tiny note">
        {withCost ? (
          <>
            {t.apiEquivalent}
            {total.approx && <div>{t.approxNote}</div>}
          </>
        ) : (
          t.costOffNote
        )}
      </div>
    </section>
  );
}

// ---------- settings ----------

function SettingsView(props: {
  t: Dict;
  s: Settings;
  update: (p: Partial<Settings>) => void;
  prices: PriceStatus | null;
  pricesBusy: boolean;
  onFetchPrices: () => void;
  rates: Rates | null;
  locale: string;
  sl: StatuslineState | null;
  slBusy: boolean;
  slError: string | null;
  onStatusline: (connect: boolean) => void;
}) {
  const { t, s, update, prices, pricesBusy, onFetchPrices, rates, locale, sl, slBusy, slError, onStatusline } = props;
  const dt = (ms: number) =>
    new Date(ms).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <main className="scroll settings">
      <section className="card">
        <label className="row">
          <span>{t.language}</span>
          <select value={s.lang} onChange={(e) => update({ lang: e.target.value as Lang })}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>{t.currency}</span>
          <select value={s.currency} onChange={(e) => update({ currency: e.target.value as Currency })}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {rates && (
          <div className="muted tiny">
            {rates.fallback
              ? t.ratesFallback
              : fmt(t.rates, { t: rates.date }) +
                " · 1 USD = " +
                CURRENCIES.filter((c) => c !== "USD")
                  .map((c) => `${rates.rates[c]} ${c}`)
                  .join(" · ")}
          </div>
        )}
        <label className="row">
          <span>{t.weekStart}</span>
          <select value={s.weekStart} onChange={(e) => update({ weekStart: Number(e.target.value) as 0 | 1 })}>
            <option value={1}>{t.monday}</option>
            <option value={0}>{t.sunday}</option>
          </select>
        </label>
        <Toggle label={t.alwaysOnTop} on={s.alwaysOnTop} onChange={(v) => update({ alwaysOnTop: v })} />
        <Toggle label={t.showIp} on={s.showIp} onChange={(v) => update({ showIp: v })} />
        <Toggle label={t.netCheck} on={s.netCheck} onChange={(v) => update({ netCheck: v })} />
        <div className="muted tiny">{t.netCheckHint}</div>
      </section>

      <section className="card">
        <div className="sub">{t.prices}</div>
        <Toggle label={t.autoPrices} on={s.autoPrices} onChange={(v) => update({ autoPrices: v })} />
        <div className="muted tiny">{t.autoPricesHint}</div>
        {s.autoPrices && (
          <div className="row">
            <span className="muted tiny">
              {prices?.error
                ? fmt(t.pricesError, { e: prices.error })
                : prices?.last_checked
                  ? fmt(t.pricesLast, { t: dt(prices.last_checked), n: prices.snapshots })
                  : t.pricesNever}
            </span>
            <button className="btn" disabled={pricesBusy} onClick={onFetchPrices}>
              {pricesBusy ? "…" : t.fetchNow}
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="row">
          <span className="sub">{t.slTitle}</span>
          <button className="btn" disabled={slBusy} onClick={() => onStatusline(!sl?.connected)}>
            {slBusy ? "…" : sl?.connected ? t.slDisconnect : t.slConnect}
          </button>
        </div>
        <div className="muted tiny">{t.slHint}</div>
        {sl?.has_other && !sl.connected && <div className="muted tiny">{t.slWrap}</div>}
        {slError && <div className="warn tiny">{fmt(t.slError, { e: slError })}</div>}
      </section>

      <section className="card">
        <Toggle label={t.claudeQuota} on={s.claudeQuota} onChange={(v) => update({ claudeQuota: v })} />
        <div className="muted tiny">{t.claudeQuotaHint}</div>
      </section>

      <div className="muted tiny foot">{t.dataSources}</div>
    </main>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row toggle">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
