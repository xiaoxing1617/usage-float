mod activity;
mod claude;
mod cli_usage;
mod drawer;
mod ip;
mod platform;
mod pricing;
mod scan;
mod statusline;
mod trust;

use pricing::{PriceBook, PriceQuality};
use scan::{ClaudeLimitHit, CodexLimits, Provider, ScanCache};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

/// Prices are re-fetched at most this often.
const PRICE_REFRESH_MS: i64 = 12 * 60 * 60 * 1000;

struct AppState {
    scan: Mutex<ScanCache>,
    prices: Mutex<PriceBook>,
    prices_path: PathBuf,
    claude_quota: Mutex<claude::QuotaCache>,
    trust: trust::ScoreCache,
    cli_usage: cli_usage::CliCache,
}

#[derive(Serialize)]
struct DailyRow {
    /// Local calendar date, YYYY-MM-DD.
    date: String,
    provider: Provider,
    model: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    /// None when price fetching is off or no price is known.
    cost_usd: Option<f64>,
    /// "exact" | "backfilled" | "approximate"
    price_quality: Option<&'static str>,
}

#[derive(Serialize)]
struct UsageReport {
    rows: Vec<DailyRow>,
    codex: Option<CodexLimits>,
    claude_hits: Vec<ClaudeLimitHit>,
    claude_statusline: statusline::StatuslineState,
    claude_plan: claude::ClaudePlan,
    generated_at: i64,
}

#[derive(Serialize)]
struct PriceStatus {
    last_checked: Option<i64>,
    snapshots: usize,
    latest_effective_from: Option<i64>,
    /// True if this call fetched a table that differed from the previous one.
    changed: bool,
    error: Option<String>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn quality_rank(q: PriceQuality) -> u8 {
    match q {
        PriceQuality::Exact => 0,
        PriceQuality::Backfilled => 1,
        PriceQuality::Approximate => 2,
    }
}

#[tauri::command]
async fn get_usage(state: State<'_, AppState>, with_cost: bool) -> Result<UsageReport, String> {
    let scan::ScanResult { events, codex, claude_hits } = {
        let mut scan = state.scan.lock().map_err(|e| e.to_string())?;
        scan.refresh()
    };
    let book = if with_cost { Some(state.prices.lock().map_err(|e| e.to_string())?.clone()) } else { None };
    let has_prices = book.as_ref().is_some_and(|b| !b.snapshots.is_empty());

    #[derive(Default)]
    struct Acc {
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
        cost: f64,
        priced: bool,
        worst: Option<PriceQuality>,
    }
    let mut groups: BTreeMap<(String, Provider, String), Acc> = BTreeMap::new();
    for e in &events {
        let date = chrono::DateTime::from_timestamp_millis(e.ts_ms)
            .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let acc = groups.entry((date, e.provider, e.model.clone())).or_default();
        acc.input += e.input;
        acc.output += e.output;
        acc.cache_read += e.cache_read;
        acc.cache_write += e.cache_write_5m + e.cache_write_1h;
        if let Some(book) = book.as_ref().filter(|_| has_prices) {
            if let Some((p, q)) = book.price_at(&e.model, e.ts_ms) {
                let mult = if e.fast { 2.0 } else { 1.0 };
                acc.cost += mult
                    * (e.input as f64 * p.input
                        + e.output as f64 * p.output
                        + e.cache_read as f64 * p.cache_read
                        + e.cache_write_5m as f64 * p.cache_write_5m
                        + e.cache_write_1h as f64 * p.cache_write_1h)
                    / 1_000_000.0;
                acc.priced = true;
                if acc.worst.is_none_or(|w| quality_rank(q) > quality_rank(w)) {
                    acc.worst = Some(q);
                }
            }
        }
    }
    let rows = groups
        .into_iter()
        .map(|((date, provider, model), a)| DailyRow {
            date,
            provider,
            model,
            input: a.input,
            output: a.output,
            cache_read: a.cache_read,
            cache_write: a.cache_write,
            cost_usd: a.priced.then_some(a.cost),
            price_quality: a.worst.map(|q| match q {
                PriceQuality::Exact => "exact",
                PriceQuality::Backfilled => "backfilled",
                PriceQuality::Approximate => "approximate",
            }),
        })
        .collect();
    Ok(UsageReport { rows, codex, claude_hits, claude_statusline: statusline::state(), claude_plan: claude::read_plan(), generated_at: now_ms() })
}

fn price_status(book: &PriceBook, changed: bool, error: Option<String>) -> PriceStatus {
    PriceStatus {
        last_checked: book.last_checked,
        snapshots: book.snapshots.len(),
        latest_effective_from: book.snapshots.last().map(|s| s.effective_from),
        changed,
        error,
    }
}

/// Fetches prices if `force` or the last check is older than 12 hours.
#[tauri::command]
async fn refresh_prices(state: State<'_, AppState>, force: bool) -> Result<PriceStatus, String> {
    let due = {
        let book = state.prices.lock().map_err(|e| e.to_string())?;
        force || book.last_checked.is_none_or(|t| now_ms() - t >= PRICE_REFRESH_MS)
    };
    if !due {
        let book = state.prices.lock().map_err(|e| e.to_string())?;
        return Ok(price_status(&book, false, None));
    }
    match pricing::fetch_latest().await {
        Ok(prices) => {
            let mut book = state.prices.lock().map_err(|e| e.to_string())?;
            let changed = book.record(now_ms(), prices);
            let err = book.save(&state.prices_path).err().map(|e| e.to_string());
            Ok(price_status(&book, changed, err))
        }
        Err(e) => {
            let book = state.prices.lock().map_err(|e| e.to_string())?;
            Ok(price_status(&book, false, Some(e)))
        }
    }
}

/// `force`: user pressed "retry" (re-reads the Keychain, ignores backoff).
#[tauri::command]
async fn get_claude_quota(state: State<'_, AppState>, force: bool) -> Result<claude::QuotaResult, String> {
    Ok(claude::fetch_quota(&state.claude_quota, force).await)
}

/// Claude quota from Claude Code's own `/usage` command (no chat, no tokens).
#[tauri::command]
async fn get_claude_cli_usage(state: State<'_, AppState>, force: bool) -> Result<cli_usage::CliUsage, String> {
    Ok(cli_usage::fetch(&state.cli_usage, force).await)
}

/// Number of Claude Code / Codex conversations running right now.
#[tauri::command]
async fn get_activity() -> activity::Activity {
    tauri::async_runtime::spawn_blocking(activity::scan).await.unwrap_or_default()
}

/// Resizes the window to `width` x `height` (physical px) and keeps it fully
/// inside the monitor's work area. When the window sits in the right / bottom
/// half of the screen it grows toward the left / top, so expanding a ball parked
/// in a corner opens the panel on screen instead of past the edge.
fn place_on_screen(window: &tauri::WebviewWindow, width: i32, height: i32) -> tauri::Result<()> {
    let pos = window.outer_position()?;
    let size = window.outer_size()?;
    let (ow, oh) = (size.width as i32, size.height as i32);
    let monitor = match window.current_monitor()? {
        Some(m) => Some(m),
        None => window
            .monitor_from_point((pos.x + ow / 2) as f64, (pos.y + oh / 2) as f64)?
            .or(window.primary_monitor()?),
    };
    let (mut x, mut y) = (pos.x, pos.y);
    if let Some(m) = monitor {
        let a = m.work_area();
        let (ax, ay, aw, ah) = (a.position.x, a.position.y, a.size.width as i32, a.size.height as i32);
        if pos.x + ow / 2 > ax + aw / 2 {
            x = pos.x + ow - width; // keep the right edge
        }
        if pos.y + oh / 2 > ay + ah / 2 {
            y = pos.y + oh - height; // keep the bottom edge
        }
        let margin = (8.0 * m.scale_factor()).round() as i32;
        x = x.clamp(ax + margin, (ax + aw - width - margin).max(ax + margin));
        y = y.clamp(ay + margin, (ay + ah - height - margin).max(ay + margin));
    }
    window.set_size(tauri::PhysicalSize::new(width as u32, height as u32))?;
    window.set_position(tauri::PhysicalPosition::new(x, y))?;
    Ok(())
}

/// Called by the UI when switching between full panel, slim bars and ball.
#[tauri::command]
async fn check_network(state: State<'_, AppState>, service: String, force: bool) -> Result<trust::NetCheck, String> {
    Ok(trust::check(&state.trust, &service, force).await)
}

#[tauri::command]
fn open_site(app: AppHandle, url: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    drawer::open(&app, &url, x, y, width, height)
}

#[tauri::command]
fn close_site(app: AppHandle) {
    drawer::close(&app);
}

#[tauri::command]
async fn get_public_ip(lang: String) -> ip::IpInfo {
    ip::fetch(&lang).await
}

#[tauri::command]
fn resize_on_screen(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    place_on_screen(&window, (width * scale).round() as i32, (height * scale).round() as i32).map_err(|e| e.to_string())
}

/// Opens a running / finished conversation in the Claude desktop app or Codex app.
#[tauri::command]
fn open_task(provider: String, id: String) -> Result<(), String> {
    activity::open_task(&provider, &id)
}

/// Resizes the window and moves it `dx` logical px horizontally, so content
/// (the floating ball) keeps its place on screen when bubbles open beside it.
/// The result is kept inside the monitor's work area.
#[tauri::command]
fn resize_shift(window: tauri::WebviewWindow, width: f64, height: f64, dx: f64) -> Result<(), String> {
    let e = |e: tauri::Error| e.to_string();
    let scale = window.scale_factor().map_err(e)?;
    let (w, h) = ((width * scale).round() as i32, (height * scale).round() as i32);
    let pos = window.outer_position().map_err(e)?;
    let (mut x, mut y) = (pos.x + (dx * scale).round() as i32, pos.y);
    if let Some(m) = window.current_monitor().map_err(e)?.or(window.primary_monitor().map_err(e)?) {
        let a = m.work_area();
        let (ax, ay, aw, ah) = (a.position.x, a.position.y, a.size.width as i32, a.size.height as i32);
        x = x.clamp(ax, (ax + aw - w).max(ax));
        y = y.clamp(ay, (ay + ah - h).max(ay));
    }
    window.set_size(tauri::PhysicalSize::new(w as u32, h as u32)).map_err(e)?;
    window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(e)?;
    Ok(())
}

/// Points Claude Code's status line at our bridge script (user clicked Connect).
#[tauri::command]
fn connect_statusline() -> Result<statusline::StatuslineState, String> {
    statusline::connect()
}

/// Restores the user's previous Claude Code status line.
#[tauri::command]
fn disconnect_statusline() -> Result<statusline::StatuslineState, String> {
    statusline::disconnect()
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            // Bring it back on screen if a monitor was unplugged or it was dragged off.
            if let Ok(size) = w.outer_size() {
                let _ = place_on_screen(&w, size.width as i32, size.height as i32);
            }
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // A floating widget: no Dock icon, controlled from the menu bar.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir()?;
            let prices_path = data_dir.join("prices.json");
            app.manage(AppState {
                scan: Mutex::new(ScanCache::default()),
                prices: Mutex::new(PriceBook::load(&prices_path)),
                prices_path,
                claude_quota: Mutex::new(claude::QuotaCache::new(data_dir.join("claude_quota.json"))),
                trust: trust::ScoreCache::default(),
                cli_usage: cli_usage::CliCache::new(data_dir.join("claude_cli_usage.json")),
            });

            let toggle = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&toggle, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(tauri::include_image!("icons/tray.png"))
                .icon_as_template(true)
                .tooltip("Usage Float")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "toggle" => toggle_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_usage, refresh_prices, get_claude_quota, resize_on_screen, connect_statusline, disconnect_statusline, get_public_ip, check_network, open_site, close_site, get_claude_cli_usage, get_activity, resize_shift, open_task])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
