//! An embedded web page shown inside the main window's drawer.
//!
//! ip.net.coffee sends `X-Frame-Options: SAMEORIGIN`, so it cannot be put in
//! an <iframe>. Instead we add a native child webview to the main window and
//! place it over the drawer's body area (coordinates come from the frontend).
//! Only a fixed allow-list of URLs can be opened, and the child webview gets
//! no IPC capabilities (capabilities/default.json only covers "main").

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

const LABEL: &str = "site";
const ALLOWED: &[&str] = &["https://ip.net.coffee/claude/", "https://ip.net.coffee/gpt/"];

pub fn open(app: &AppHandle, url: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if !ALLOWED.contains(&url) {
        return Err("url_not_allowed".into());
    }
    let parsed: tauri::Url = url.parse().map_err(|_| "bad_url".to_string())?;
    let (pos, size) = (LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)));
    if let Some(wv) = app.get_webview(LABEL) {
        wv.navigate(parsed).map_err(|e| e.to_string())?;
        wv.set_position(pos).map_err(|e| e.to_string())?;
        wv.set_size(size).map_err(|e| e.to_string())?;
        return wv.show().map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("no_main_window")?;
    window
        .add_child(WebviewBuilder::new(LABEL, WebviewUrl::External(parsed)), pos, size)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn close(app: &AppHandle) {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.close();
    }
}
