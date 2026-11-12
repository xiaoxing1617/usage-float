import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  getClaudeCliUsage,
  getActivity,
  openTask,
  type Activity,
  type CliUsage,
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
import { clock, loadTasks, mergeTasks, relTime, saveTasks, sortTasks, type Side, type TrackedTask } from "./tasks";
import {
  REPO,
  REPO_URL,
  RELEASES_URL,
  checkForUpdate,
  currentVersion,
  installUpdate,
  type UpdateState,
} from "./update";
import "./App.css";

// ---------- settings (per-viewer convenience; safe defaults if storage fails) ----------

interface Settings {
  lang: Lang;
  theme: Theme;
  currency: Currency;
  autoPrices: boolean;
  claudeQuota: boolean;
  /** Read the Claude quota with Claude Code's `/usage` command. */
  claudeCli: boolean;
  /** Show running conversation counts on the floating ball. */
  ballActivity: boolean;
  /** Task list bubbles beside the ball, remembered per side. */
  ballListClaude: boolean;
  ballListGpt: boolean;
  alwaysOnTop: boolean;
  showIp: boolean;
  netCheck: boolean;
  /** Look for a new release on startup and twice a day. */
  autoUpdate: boolean;
  weekStart: 0 | 1;
  period: PeriodId;
  custom: Range;
  /** full panel, slim bars, or a small floating ball */
  mode: Mode;
}

type Mode = "full" | "ball";
type Theme = "auto" | "light" | "dark";
const THEMES: Theme[] = ["auto", "light", "dark"];

const SETTINGS_KEY = "uf.settings";

function loadSettings(): Settings {
  const today = ymd(new Date());
  const defaults: Settings = {
    lang: detectLang(),
    theme: "auto",
    currency: "USD",
    autoPrices: false,
    claudeQuota: false,
    claudeCli: true,
    ballActivity: true,
    ballListClaude: true,
    ballListGpt: true,
    alwaysOnTop: true,
    showIp: true,
    netCheck: true,
    autoUpdate: true,
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
  const [cli, setCli] = useState<CliUsage | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [tasks, setTasks] = useState<TrackedTask[]>(loadTasks);
  const updateTasks = useCallback((f: (prev: TrackedTask[]) => TrackedTask[]) => {
    setTasks((prev) => {
      const next = f(prev);
      if (next !== prev) saveTasks(next);
      return next;
    });
  }, []);
  const [slBusy, setSlBusy] = useState(false);
  const [slError, setSlError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // New version: checked quietly in the background; shown in settings.
  const [upd, setUpd] = useState<UpdateState>({ phase: "idle", current: "" });
  const runCheck = useCallback(async () => {
    const current = await currentVersion();
    setUpd((u) => (u.phase === "downloading" || u.phase === "installing" ? u : { ...u, phase: "checking", current }));
    const r = await checkForUpdate(current);
    setUpd((u) => (u.phase === "downloading" || u.phase === "installing" ? u : r));
  }, []);
  useEffect(() => {
    currentVersion().then((current) => setUpd((u) => ({ ...u, current })));
  }, []);
  useEffect(() => {
    if (!s.autoUpdate) return;
    const first = setTimeout(runCheck, 8_000);
    const id = setInterval(runCheck, 12 * 3600_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [s.autoUpdate, runCheck]);
  const runInstall = useCallback(() => {
    if (upd.auto) {
      installUpdate((p) => setUpd((u) => ({ ...u, ...p }))).catch((e) =>
        setUpd((u) => ({ ...u, phase: "error", error: String(e) })),
      );
    } else openLink(RELEASES_URL);
  }, [upd.auto]);

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
      setClaudeQuota((prev) => ({
        windows: prev?.windows ?? [],
        fetched_at: prev?.fetched_at ?? null,
        error: String(e),
        retry_at: null,
      }));
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

  // Claude quota from Claude Code's `/usage` (no chat, no tokens). Every 10 min.
  const loadCli = useCallback(async (force: boolean) => {
    setCliBusy(true);
    try {
      setCli(await getClaudeCliUsage(force));
    } catch (e) {
      setCli((prev) => ({
        windows: prev?.windows ?? [],
        fetched_at: prev?.fetched_at ?? null,
        error: String(e),
      }));
    } finally {
      setCliBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!s.claudeCli) {
      setCli(null);
      return;
    }
    loadCli(false);
    const id = setInterval(() => loadCli(false), CLAUDE_POLL_MS);
    return () => clearInterval(id);
  }, [s.claudeCli, loadCli]);

  // Running conversations. Polled often while the ball shows, slowly otherwise,
  // so tasks that finish while the panel is open still end up as "finished".
  useEffect(() => {
    if (!s.ballActivity) return;
    const tick = () =>
      getActivity()
        .then((a: Activity) => updateTasks((prev) => mergeTasks(prev, a, Date.now())))
        .catch(() => {});
    tick();
    const id = setInterval(tick, s.mode === "ball" ? 4_000 : 15_000);
    return () => clearInterval(id);
  }, [s.ballActivity, s.mode, updateTasks]);

  // Clock for countdowns.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Window behaviour.
  useEffect(() => {
    if (isTauri())
      getCurrentWindow()
        .setAlwaysOnTop(s.alwaysOnTop)
        .catch(() => {});
  }, [s.alwaysOnTop]);
  useEffect(() => {
    // The ball sizes itself (it grows when task bubbles are open).
    if (!isTauri() || s.mode === "ball") return;
    const [width, height] = SIZES[s.mode];
    invoke("resize_on_screen", { width, height }).catch(() => {});
  }, [s.mode]);

  useEffect(() => {
    document.documentElement.lang = s.lang;
  }, [s.lang]);
  useEffect(() => {
    const root = document.documentElement;
    if (s.theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = s.theme;
  }, [s.theme]);

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
      setIp({
        ip: null,
        country: null,
        source: null,
        region: null,
        city: null,
        fetched_at: Date.now(),
        error: String(e),
      });
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
    setNet((n) => ({
      ...n,
      [service]: n[service] && n[service] !== "busy" ? n[service] : "busy",
    }));
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
    if (s.claudeCli) loadCli(true);
    if (s.showIp) loadIp();
    if (s.netCheck) (["claude", "openai"] as const).forEach((p) => runNet(p, false));
  };

  const claudeView = effectiveClaudeWindows(
    claudeQuota,
    report?.claude_statusline,
    cli,
    report?.claude_hits ?? [],
    now,
  );
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
        tasks={s.ballActivity ? tasks : []}
        onRemove={(side, id) => updateTasks((prev) => prev.filter((x) => !(x.side === side && x.id === id)))}
        onClearDone={(side) => updateTasks((prev) => prev.filter((x) => x.side !== side || x.ended_at == null))}
        open={{ claude: s.ballListClaude, openai: s.ballListGpt }}
        onToggle={(side, v) => update(side === "claude" ? { ballListClaude: v } : { ballListGpt: v })}
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
          <button
            className="traffic"
            title={t.hide}
            aria-label={t.hide}
            onClick={() => {
              setDrawer(null);
              if (isTauri()) getCurrentWindow().hide();
            }}
          >
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
            {view === "main" && upd.phase === "available" && (
              <span className="newdot" title={fmt(t.updAvailable, { v: upd.latest ?? "" })} />
            )}
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
          upd={upd}
          onCheckUpdate={runCheck}
          onInstallUpdate={runInstall}
        />
      ) : (
        <main className="scroll">
          {loadError && <div className="error">{loadError}</div>}
          {s.showIp && (
            <button
              className="iprow"
              title={[
                ip?.ip && ip.country
                  ? [flagOf(ip.country), regionName(ip.country, locale), ip.region, ip.city].filter(Boolean).join(" ")
                  : "",
                t.ipHint,
              ]
                .filter(Boolean)
                .join("\n")}
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
            net={
              s.netCheck && (
                <NetBadge
                  t={t}
                  r={net.claude}
                  onScore={() => setDrawer({ kind: "site", provider: "claude" })}
                  onLatency={() => setDrawer({ kind: "latency", provider: "claude" })}
                />
              )
            }
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
                cli={cli}
                cliOn={s.claudeCli}
                cliBusy={cliBusy}
                onCliRetry={() => loadCli(true)}
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
            name="ChatGPT"
            net={
              s.netCheck && (
                <NetBadge
                  t={t}
                  r={net.openai}
                  onScore={() => setDrawer({ kind: "site", provider: "openai" })}
                  onLatency={() => setDrawer({ kind: "latency", provider: "openai" })}
                />
              )
            }
            plan={codexPlanLabel(report?.codex?.plan)}
            t={t}
            now={now}
            windows={report?.codex?.windows}
            body={
              !report?.codex ? (
                <div className="muted small">{t.codexNone}</div>
              ) : report.codex.observed_at ? (
                <div className="muted small">
                  {fmt(t.codexFrom, {
                    t: duration(now - report.codex.observed_at, t),
                  })}
                </div>
              ) : null
            }
          />
          <Stats t={t} s={s} update={update} report={report} withCost={withCost} money={money} />
          <footer className="muted small foot">
            {report &&
              fmt(t.updated, {
                t: new Date(report.generated_at).toLocaleTimeString(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
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
  if (k in t) return t[k];
  // Model-specific weekly windows from /usage, e.g. "seven_day_fable" → "Weekly · Fable".
  const m = key.match(/^seven_day_(.+)$/);
  if (m) return `${t.win_seven_day} · ${m[1].replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
  return t.win_other;
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
const PNAME: Record<ProviderId, string> = { claude: "Claude", openai: "ChatGPT" };

type DrawerState = { kind: "site" | "latency"; provider: ProviderId } | null;

const Shield = () => (
  <svg className="shield" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 .8 1.6 2.4v3.2c0 2.7 1.9 4.7 4.4 5.6 2.5-.9 4.4-2.9 4.4-5.6V2.4z" />
    <path className="tick" d="M3.9 6.1 5.4 7.5 8.2 4.6" />
  </svg>
);

function NetBadge(props: { t: Dict; r: NetCheck | "busy" | undefined; onScore: () => void; onLatency: () => void }) {
  const { t, r, onScore, onLatency } = props;
  if (!r) return null;
  if (r === "busy") return <span className="net muted">…</span>;
  let scoreEl: React.ReactNode = null;
  if (r.trust_score != null) {
    const c = scoreColor(r.trust_score);
    const lv = r.restricted ? t.netRestricted : (t[`lv_${scoreLevel(r.trust_score)}` as keyof Dict] as string);
    const tip = `${t.trust} ${r.trust_score} · ${lv}\n${t.scoreClick}`;
    scoreEl = (
      <button
        className="score"
        style={{ background: c.bg, color: c.fg }}
        title={tip}
        aria-label={tip}
        onClick={onScore}
      >
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
      invoke("open_site", {
        url,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      }).catch(() => {});
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
    <div
      className="drawer"
      role="dialog"
      aria-label={state.kind === "site" ? fmt(t.siteTitle, { name }) : fmt(t.latTitle, { name })}
    >
      <div className="drawerhead">
        <button className="tbtn" onClick={onClose}>
          <span className="ico">‹</span>
          {t.back}
        </button>
        <span className="drawertitle">
          {state.kind === "site" ? fmt(t.siteTitle, { name }) : fmt(t.latTitle, { name })}
        </span>
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
              <span>
                <i className="d fast" />
                &lt; 250ms {t.lat_fast}
              </span>
              <span>
                <i className="d ok" />
                &lt; 500ms {t.lat_ok}
              </span>
              <span>
                <i className="d slow" />≥ 500ms {t.lat_slow}
              </span>
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
                <dd>
                  {now - res.checked_at < 60_000 ? t.ago_s : fmt(t.agoFmt, { t: duration(now - res.checked_at, t) })}
                </dd>
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
      {windows?.map((w) => (
        <QuotaBar key={w.key} w={w} t={t} now={now} />
      ))}
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
  cli: CliUsage | null;
  cliOn: boolean;
  cliBusy: boolean;
  onCliRetry: () => void;
  busy: boolean;
  slBusy: boolean;
  slError: string | null;
  onRetry: () => void;
  onConnect: () => void;
  onUseEndpoint: () => void;
}) {
  const {
    t,
    now,
    view,
    sl,
    endpointOn,
    quota,
    cli,
    cliOn,
    cliBusy,
    onCliRetry,
    busy,
    slBusy,
    slError,
    onRetry,
    onConnect,
    onUseEndpoint,
  } = props;
  const ago = (ms: number | null) => duration(now - (ms ?? now), t);
  const source =
    view.source === "cli"
      ? fmt(t.cliFrom, { t: ago(view.at) })
      : view.source === "statusline"
        ? fmt(t.slFrom, { t: ago(view.at) })
        : view.source === "api"
          ? fmt(t.apiFrom, { t: ago(view.at) })
          : view.source === "logs"
            ? t.logsFrom
            : null;
  // Endpoint errors only matter when the endpoint is the best source we have.
  const showApiError = endpointOn && quota?.error && !view.source;
  const showCliError = cliOn && cli?.error && view.source !== "cli";
  const connected = sl?.connected ?? false;
  return (
    <>
      {source && <div className="muted tiny">{source}</div>}
      {connected && !sl?.windows.length && view.source !== "cli" && <div className="muted tiny">{t.slWaiting}</div>}
      {cliOn && cliBusy && !view.source && <div className="muted tiny">{t.cliLoading}</div>}
      {showCliError && (
        <div className="qerr">
          <div className="warn tiny">{cliError(cli!.error!, t)}</div>
          <button className="link tiny" disabled={cliBusy} onClick={onCliRetry}>
            {cliBusy ? "…" : t.retry}
          </button>
        </div>
      )}
      {showApiError && (
        <div className="qerr">
          <div className="warn small">{quotaError(quota!.error!, t)}</div>
          {quota!.retry_at && (
            <div className="muted tiny">{fmt(t.autoRetry, { t: duration(quota!.retry_at - now, t) })}</div>
          )}
          <button className="btn" disabled={busy} onClick={onRetry}>
            {busy ? "…" : t.retry}
          </button>
        </div>
      )}
      {!connected && (!view.source || view.source === "logs") && !(cliOn && cliBusy) && (
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

function cliError(code: string, t: Dict): string {
  const k = ("cliErr_" + code) as keyof Dict;
  return k in t ? t[k] : fmt(t.cliErr_other, { e: code });
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
 * Round widget: left half = Claude, right half = ChatGPT.
 * Each half: "5h" caption, big 5-hour remaining %, weekly remaining underneath.
 * The ring halves fill from the bottom by the 5-hour remaining.
 */
const BALL = 108;
/** Bubble width plus the gap to the ball. */
const BUBBLE_W = 224;

function Ball(props: {
  t: Dict;
  claude: QuotaWindow[];
  gpt: QuotaWindow[];
  tasks: TrackedTask[];
  onRemove: (side: Side, id: string) => void;
  onClearDone: (side: Side) => void;
  now: number;
  open: Record<Side, boolean>;
  onToggle: (side: Side, open: boolean) => void;
  onOpen: () => void;
}) {
  const { t, claude, gpt, tasks, onRemove, onClearDone, now, open, onToggle, onOpen } = props;
  const sideOf = (id: Side, name: string, ws: QuotaWindow[]) => {
    const list = sortTasks(tasks.filter((x) => x.side === id));
    const running = list.filter((x) => x.ended_at == null).length;
    return {
      id,
      name,
      h5: leftFor(ws, "five_hour", now),
      wk: leftFor(ws, "seven_day", now),
      running,
      done: list.length - running,
      /** what the badge shows: running tasks first, else finished ones */
      busy: running || list.length,
      tasks: list,
    };
  };
  const sides = [sideOf("claude", "Claude", claude), sideOf("openai", "ChatGPT", gpt)];

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
      if (isTauri())
        getCurrentWindow()
          .startDragging()
          .catch(() => {});
    }
  };
  const onUp = () => {
    if (start.current && !dragged.current) onOpen();
    start.current = null;
  };

  // Bubbles: shown when that side has running tasks and the user left it open.
  // `closing` plays the collapse animation before the bubble is removed.
  const [closing, setClosing] = useState<Side | null>(null);
  const shown = (id: Side, busy: number) => busy > 0 && open[id];
  const collapse = (id: Side) => {
    setClosing(id);
    window.setTimeout(() => {
      onToggle(id, false);
      setClosing(null);
    }, 180);
  };
  const left = shown("claude", sides[0].busy);
  const right = shown("openai", sides[1].busy);

  // Grow the window around the ball so the ball itself stays where it is.
  const stage = useRef<HTMLDivElement>(null);
  const [contentH, setContentH] = useState(BALL);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContentH(Math.ceil(el.scrollHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const applied = useRef<number | null>(null); // left offset of the ball currently applied
  useEffect(() => {
    if (!isTauri()) return;
    const offset = left ? BUBBLE_W : 0;
    const width = BALL + offset + (right ? BUBBLE_W : 0);
    const height = Math.max(BALL, contentH);
    if (applied.current == null) {
      invoke("resize_on_screen", { width, height }).catch(() => {});
    } else {
      invoke("resize_shift", {
        width,
        height,
        dx: applied.current - offset,
      }).catch(() => {});
    }
    applied.current = offset;
  }, [left, right, contentH]);

  // Two concentric half rings per side, from 6 o'clock up to 12 o'clock:
  // outer (thick) = 5-hour remaining, inner (thin) = weekly remaining.
  const S = 100;
  const C = S / 2;
  const rings = [
    { key: "h5" as const, r: 46, cls: "ring" },
    { key: "wk" as const, r: 40, cls: "ring wkring" },
  ];
  const arc = (r: number, isLeft: boolean) => `M ${C} ${C + r} A ${r} ${r} 0 0 ${isLeft ? 1 : 0} ${C} ${C - r}`;
  const pctText = (p: number | null) => (p == null ? "—" : `${p}%`);
  const tip = [
    t.ballHint,
    ...sides.map(
      (x) =>
        `${x.name}: 5h ${pctText(x.h5)} · ${t.win_seven_day} ${pctText(x.wk)}` +
        (x.running ? ` · ${fmt(t.ballRunning, { n: x.running })}` : "") +
        (x.done ? ` · ${fmt(t.taskDoneN, { n: x.done })}` : ""),
    ),
  ].join("\n");

  const bubble = (x: (typeof sides)[number]) =>
    shown(x.id, x.busy) ? (
      <TaskBubble
        key={"bubble" + x.id}
        t={t}
        side={x.id}
        name={x.name}
        tasks={x.tasks}
        running={x.running}
        done={x.done}
        closing={closing === x.id}
        onCollapse={() => collapse(x.id)}
        onRemove={(id) => onRemove(x.id, id)}
        onClearDone={() => onClearDone(x.id)}
      />
    ) : null;

  return (
    <div className="ballstage" ref={stage}>
      {bubble(sides[0])}
      <div className="ballwrap">
        <div
          className={"ball" + (sides.some((x) => x.running) ? " active" : "")}
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
                      <path
                        d={d}
                        className={`${g.cls} ${x.id} ${lvl(v)}`}
                        strokeDasharray={`${(len * v) / 100} ${len}`}
                      />
                    )}
                  </g>
                );
              }),
            )}
          </svg>
          {sides.map((x) =>
            x.busy > 0 ? (
              <button
                key={"badge" + x.id + (x.running ? "r" : "d") + x.busy}
                className={`busy ${x.id}` + (x.running ? "" : " idle") + (shown(x.id, x.busy) ? " on" : "")}
                title={[
                  x.running ? fmt(t.ballRunning, { n: x.running }) : null,
                  x.done ? fmt(t.taskDoneN, { n: x.done }) : null,
                  shown(x.id, x.busy) ? t.taskCollapse : t.taskExpand,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (shown(x.id, x.busy)) collapse(x.id);
                  else onToggle(x.id, true);
                }}
              >
                {x.busy > 9 ? "9+" : x.busy}
              </button>
            ) : null,
          )}
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
      {bubble(sides[1])}
    </div>
  );
}

function TaskBubble(props: {
  t: Dict;
  side: Side;
  name: string;
  tasks: TrackedTask[];
  running: number;
  done: number;
  closing: boolean;
  onCollapse: () => void;
  onRemove: (id: string) => void;
  onClearDone: () => void;
}) {
  const { t, side, name, tasks, running, done, closing, onCollapse, onRemove, onClearDone } = props;
  // Ticks every second so the timers run smoothly.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Fade the list edge when it scrolls, so it's clear there is more.
  const listRef = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState({ top: false, bottom: false });
  const checkMore = () => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setMore((m) => (m.top === top && m.bottom === bottom ? m : { top, bottom }));
  };
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkMore);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(checkMore, [tasks.length]);
  // When a jump fails, the row shakes and says why for a few seconds.
  const [err, setErr] = useState<{ id: string; msg: string } | null>(null);
  const errTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(errTimer.current), []);
  const open = (task: TrackedTask) => {
    if (!task.openable) return;
    openTask(side, task.id).catch((e) => {
      const code = String(e);
      const msg =
        code === "not_found"
          ? t.openErr_not_found
          : code === "app_missing"
            ? side === "claude"
              ? t.openErr_app_claude
              : t.openErr_app_codex
            : t.openErr_other;
      window.clearTimeout(errTimer.current);
      setErr({ id: task.id, msg });
      errTimer.current = window.setTimeout(() => setErr(null), 4000);
    });
  };
  return (
    <div className={`bubble ${side}` + (closing ? " closing" : "")} role="dialog" aria-label={name}>
      <span className="tail" aria-hidden="true" />
      <div className="bhead">
        <span className="bname">{name}</span>
        <span className="bpills">
          {running > 0 && <span className="bcount live">{fmt(t.pillRunning, { n: running })}</span>}
          {done > 0 && <span className="bcount">{fmt(t.pillDone, { n: done })}</span>}
        </span>
      </div>
      <ul
        className={"tasks" + (more.top ? " more-top" : "") + (more.bottom ? " more-bottom" : "")}
        ref={listRef}
        onScroll={checkMore}
        onAnimationEnd={checkMore}
      >
        {tasks.map((task, i) => {
          const live = task.ended_at == null;
          const title = task.title ?? t.taskUntitled;
          const ran = task.started_at != null ? clock((task.ended_at ?? now) - task.started_at) : null;
          const firstDone = !live && (i === 0 || tasks[i - 1].ended_at == null);
          return (
            <Fragment key={task.id}>
              {firstDone && (
                <li className="tsep" aria-hidden="true">
                  <span>{t.taskDoneSection}</span>
                </li>
              )}
              <li
                className={
                  "task" +
                  (live ? " live" : " done") +
                  (task.openable ? " link" : "") +
                  (err?.id === task.id ? " err" : "")
                }
                style={{ animationDelay: `${40 + i * 40}ms` }}
                role={task.openable ? "button" : undefined}
                tabIndex={task.openable ? 0 : undefined}
                title={task.openable ? `${title}\n${t.taskOpen}` : title}
                onClick={() => open(task)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(task);
                  }
                }}
              >
                <span className="tstate" aria-hidden="true">
                  {live ? (
                    <span className="eq">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    <svg viewBox="0 0 20 20" width="20" height="20">
                      <circle cx="10" cy="10" r="10" />
                      <path d="M6 10.3 8.7 13l5.3-5.6" />
                    </svg>
                  )}
                </span>
                <span className="tbody">
                  <span className="trow">
                    <span className="ttitle">{title}</span>
                    {!live && (
                      <button
                        className="tx"
                        title={t.taskRemove}
                        aria-label={t.taskRemove}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(task.id);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
                          <path d="M2 2l6 6M8 2 2 8" />
                        </svg>
                      </button>
                    )}
                  </span>
                  {err?.id === task.id ? (
                    <span className="terr" role="alert">
                      {err.msg}
                    </span>
                  ) : (
                    <span className="tmeta">
                      <span title={task.created_at != null ? new Date(task.created_at).toLocaleString() : undefined}>
                        {task.created_at != null ? fmt(t.taskCreated, { t: relTime(task.created_at, now, t) }) : ""}
                      </span>
                      {ran && <span className="tdur">{fmt(live ? t.taskRunningFor : t.taskRanFor, { t: ran })}</span>}
                    </span>
                  )}
                </span>
              </li>
            </Fragment>
          );
        })}
      </ul>
      <div className="bfoot">
        {done > 0 && (
          <button className="bclear" onClick={onClearDone}>
            {t.taskClearDone}
          </button>
        )}
        <button className="bfold" onClick={onCollapse} title={t.taskCollapse} aria-label={t.taskCollapse}>
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path
              d="M3 7.5 6 4.5l3 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{t.taskCollapse}</span>
        </button>
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
const emptyAgg = (): Agg => ({
  tokens: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  approx: false,
});
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

  const byProvider: Record<ProviderId, Agg> = {
    claude: emptyAgg(),
    openai: emptyAgg(),
  };
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
            <input
              type="date"
              value={s.custom.end}
              onChange={(e) => update({ custom: { ...s.custom, end: e.target.value } })}
            />
          </label>
        </div>
      )}
      <div className="muted tiny range">
        {range.start === range.end ? range.start : `${range.start} → ${range.end}`}
      </div>

      <div className="sumrow">
        <span className="muted small">{t.total}</span>
        <span className="big">{withCost ? money(total.cost) : compact(total.tokens) + " " + t.tokens}</span>
        {withCost && (
          <span className="muted tiny">
            {compact(total.tokens)} {t.tokens}
          </span>
        )}
      </div>

      <div className="totals">
        {(["claude", "openai"] as ProviderId[]).map((p) => (
          <div key={p} className="tot">
            <div className="muted tiny">
              <span className={"swatch " + p} />
              {p === "claude" ? "Claude" : "ChatGPT"}
            </div>
            <div className="big">{withCost ? money(byProvider[p].cost) : compact(byProvider[p].tokens)}</div>
            <div className="muted tiny">{withCost ? `${compact(byProvider[p].tokens)} ${t.tokens}` : t.tokens}</div>
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
                const tip = `${d}  Claude ${withCost ? money(v.claude) : compact(v.claude)} · ChatGPT ${withCost ? money(v.openai) : compact(v.openai)}`;
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
  upd: UpdateState;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  const { t, s, update, prices, pricesBusy, onFetchPrices, rates, locale, sl, slBusy, slError, onStatusline } = props;
  const { upd, onCheckUpdate, onInstallUpdate } = props;
  const busy = upd.phase === "checking" || upd.phase === "downloading" || upd.phase === "installing";
  const updText =
    upd.phase === "checking"
      ? t.updChecking
      : upd.phase === "latest"
        ? t.updLatest
        : upd.phase === "available"
          ? fmt(t.updAvailable, { v: upd.latest ?? "" })
          : upd.phase === "downloading"
            ? fmt(t.updDownloading, { p: upd.progress != null ? Math.round(upd.progress * 100) + "%" : "…" })
            : upd.phase === "installing"
              ? t.updInstalling
              : upd.phase === "error"
                ? t.updError
                : "";
  const dt = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <main className="scroll settings">
      <section className={"card about" + (upd.phase === "available" ? " has-update" : "")}>
        <div className="row">
          <span className="sub nowrap">
            {t.appName} <span className="ver">v{upd.current || "…"}</span>
          </span>
          {upd.phase === "available" ? (
            <button className="btn primary" onClick={onInstallUpdate}>
              {upd.auto ? t.updInstall : t.updDownload}
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={onCheckUpdate}>
              {busy ? "…" : t.updCheck}
            </button>
          )}
        </div>
        {(updText || upd.phase === "idle") && (
          <div className="updline">
            <span
              className={"tiny " + (upd.phase === "available" ? "updnew" : upd.phase === "error" ? "warn" : "muted")}
            >
              {updText || t.updIdle}
            </span>
          </div>
        )}
        {upd.phase === "downloading" && (
          <div className="updbar">
            <i style={{ width: `${Math.round((upd.progress ?? 0.05) * 100)}%` }} />
          </div>
        )}
        {upd.phase === "error" && (
          <button className="linkish tiny" onClick={() => openLink(RELEASES_URL)}>
            {t.updOpenPage}
          </button>
        )}
        <Toggle label={t.updAuto} on={s.autoUpdate} onChange={(v) => update({ autoUpdate: v })} />
        <button className="btn link repo" title={REPO_URL} onClick={() => openLink(REPO_URL)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
            />
          </svg>
          {REPO}
        </button>
      </section>

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
          <span>{t.theme}</span>
          <select value={s.theme} onChange={(e) => update({ theme: e.target.value as Theme })}>
            {THEMES.map((th) => (
              <option key={th} value={th}>
                {t[`theme_${th}`]}
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
        <Toggle label={t.ballActivity} on={s.ballActivity} onChange={(v) => update({ ballActivity: v })} />
        <div className="muted tiny">{t.ballActivityHint}</div>
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
                  ? fmt(t.pricesLast, {
                      t: dt(prices.last_checked),
                      n: prices.snapshots,
                    })
                  : t.pricesNever}
            </span>
            <button className="btn" disabled={pricesBusy} onClick={onFetchPrices}>
              {pricesBusy ? "…" : t.fetchNow}
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <Toggle label={t.cliTitle} on={s.claudeCli} onChange={(v) => update({ claudeCli: v })} />
        <div className="muted tiny">{t.cliHint}</div>
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

function openLink(url: string) {
  if (isTauri()) openUrl(url).catch(() => {});
  else window.open(url, "_blank");
}
