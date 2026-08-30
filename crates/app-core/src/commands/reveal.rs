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
/// - A path that no longer exists degrades to its closest existing
///   ancestor — the Changes view and commit details list files that may
///   have been deleted or renamed since.
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
    let target = existing_ancestor(&p).ok_or_else(|| format!("path not found: {}", p.display()))?;

    #[cfg(target_os = "macos")]
    {
        let status = if target.is_dir() {
            std::process::Command::new("open").arg(&target).status()
        } else {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&target)
                .status()
        };
        return status.map(|_| ()).map_err(|e| e.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // explorer.exe returns a non-zero exit code even on success —
        // judge by spawn success only.
        let native = explorer_path(&target);
        let status = if target.is_dir() {
            std::process::Command::new("explorer").arg(&native).spawn()
        } else {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", native))
                .spawn()
        };
        return status.map(|_| ()).map_err(|e| e.to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let dir = match target.parent() {
            Some(parent) if !target.is_dir() => parent.to_path_buf(),
            _ => target.clone(),
        };
        let status = std::process::Command::new("xdg-open").arg(&dir).status();
        return status.map(|_| ()).map_err(|e| e.to_string());
    }
}

/// The longest prefix of `path` that still exists on disk, `path` itself
/// first. Returns `None` when nothing on the path survives.
///
/// Paths handed to this command come from git, which reports them with
/// forward slashes and may describe files that have since been deleted.
/// Revealing a missing path is not a no-op: `open -R` fails outright and
/// Explorer silently falls back to its default view.
fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut candidate = Some(path);
    while let Some(current) = candidate {
        if current.exists() {
            return Some(current.to_path_buf());
        }
        candidate = current.parent();
    }
    None
}

/// Render `path` the way Explorer expects: backslash-separated.
///
/// `root.join(relative)` mixes separators — Windows `PathBuf::push` only
/// inserts `MAIN_SEPARATOR` between the two halves and leaves git's
/// forward slashes alone — producing `C:\repo\src/lib.rs`. Explorer
/// accepts that for plain navigation but not for `/select,`: it cannot
/// resolve the switch's argument and opens its default view (Quick access
/// / This PC) instead of the file's folder.
#[cfg(any(target_os = "windows", test))]
fn explorer_path(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_path_uses_backslashes() {
        assert_eq!(
            explorer_path(Path::new(r"C:\repo\src/lib.rs")),
            r"C:\repo\src\lib.rs"
        );
        assert_eq!(
            explorer_path(Path::new("C:/repo/src/lib.rs")),
            r"C:\repo\src\lib.rs"
        );
        assert_eq!(explorer_path(Path::new(r"C:\repo")), r"C:\repo");
    }

    #[test]
    fn existing_ancestor_falls_back_to_the_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone").join("file.rs");
        assert_eq!(existing_ancestor(&missing).as_deref(), Some(dir.path()));

        let present = dir.path().join("here.rs");
        std::fs::write(&present, b"").unwrap();
        assert_eq!(
            existing_ancestor(&present).as_deref(),
            Some(present.as_path())
        );
    }

    #[test]
    fn existing_ancestor_is_none_when_nothing_survives() {
        // Relative, so it resolves against the test cwd where it — and its
        // parent — do not exist.
        assert_eq!(
            existing_ancestor(Path::new("no-such-dir-here/file.rs")),
            None
        );
    }
}
