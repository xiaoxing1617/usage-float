//! Small platform helpers so the rest of the code stays the same on macOS and Windows.

use std::path::PathBuf;
use std::process::Command;

/// A command that never flashes a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Runs an executable found on disk. Windows `.cmd` / `.bat` shims (npm
/// installs) have to go through `cmd /C`.
pub fn command_for(bin: &std::path::Path) -> Command {
    #[cfg(windows)]
    {
        let ext = bin.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext == "cmd" || ext == "bat" {
            let mut c = command("cmd");
            c.arg("/C").arg(bin);
            return c;
        }
    }
    command(bin)
}

/// Where the `claude` command line is usually installed.
pub fn claude_candidates() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    #[cfg(windows)]
    {
        let appdata = dirs::data_dir().unwrap_or_default();
        vec![
            home.join(".local\\bin\\claude.exe"),
            appdata.join("npm\\claude.cmd"),
            home.join(".bun\\bin\\claude.exe"),
            home.join("scoop\\shims\\claude.exe"),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
            home.join(".npm-global/bin/claude"),
            home.join(".bun/bin/claude"),
        ]
    }
}

/// Asks the shell where `claude` is (GUI apps don't inherit the shell's PATH on macOS).
pub fn which_claude() -> Option<PathBuf> {
    #[cfg(windows)]
    let out = command("where").arg("claude").output().ok()?;
    #[cfg(not(windows))]
    let out = command("/bin/zsh").args(["-lc", "command -v claude"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().map(|l| PathBuf::from(l.trim())).find(|p| p.is_absolute() && p.is_file())
}

/// Opens a URL with whatever app handles it. Errs when no app does.
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let out = command("/usr/bin/open").arg(url).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err("app_missing".into()) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| "app_missing".to_string())
    }
}
