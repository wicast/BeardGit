//! Reveal files / folders in the OS file manager (Finder, Explorer,
//! xdg-open).
//!
//! Why a dedicated command instead of `@tauri-apps/plugin-opener`:
//! `opener:allow-open-path` validates paths against a webview-side scope
//! and rejects workspace paths with "Not allowed to open path" — the same
//! limitation that pushed `requests_open_in_editor` to shell out natively.
//! This command is the app-trusted equivalent for revealing any on-disk
//! path the UI already shows.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::commands::get_active_project_path;

/// Open `path` in the OS file manager.
///
/// Relative paths resolve against the active project's root (the UI menus
/// pass repo-relative paths); absolute paths are used as-is.
///
/// - Directories are opened themselves.
/// - Files are revealed with selection on macOS (`open -R`) and Windows
///   (`explorer /select,`). Linux has no cross-desktop select, so the
///   containing directory is opened instead.
#[tauri::command]
pub fn reveal_in_file_manager(
    path: String,
    state: State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let raw = Path::new(&path);
    let p: PathBuf = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        let root = get_active_project_path(&state)?;
        root.join(raw)
    };
    if !p.exists() {
        return Err(format!("path not found: {}", p.display()));
    }

    #[cfg(target_os = "macos")]
    {
        let status = if p.is_dir() {
            std::process::Command::new("open").arg(&p).status()
        } else {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&p)
                .status()
        };
        return status.map(|_| ()).map_err(|e| e.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // explorer.exe returns a non-zero exit code even on success —
        // judge by spawn success only.
        let status = if p.is_dir() {
            std::process::Command::new("explorer").arg(&p).spawn()
        } else {
            let arg = format!("/select,{}", p.display());
            std::process::Command::new("explorer").arg(arg).spawn()
        };
        return status.map(|_| ()).map_err(|e| e.to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let target = if p.is_dir() {
            p.to_path_buf()
        } else {
            p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| p.to_path_buf())
        };
        let status = std::process::Command::new("xdg-open")
            .arg(&target)
            .status();
        return status.map(|_| ()).map_err(|e| e.to_string());
    }
}
