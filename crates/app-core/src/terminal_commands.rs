//! Tauri commands for terminal session management.

use crate::ipc_error::IpcError;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;
use terminal::{
    SessionId, ShellOption, TerminalConfig, TerminalManager, available_shells, resolve_shell,
};

/// Shells the terminal picker can offer on this host.
#[tauri::command]
pub fn terminal_list_shells() -> Vec<ShellOption> {
    available_shells()
}

/// Spawn a new terminal session in the given directory.
///
/// `shell` is a path from [`terminal_list_shells`], echoed back verbatim;
/// `None` uses the system default.
#[tauri::command]
pub fn terminal_spawn(
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    terminal_manager: State<'_, Arc<TerminalManager>>,
) -> Result<SessionId, IpcError> {
    // Args are re-derived from the discovered shell instead of being taken
    // from the payload: Git Bash needs `--login -i` to start interactively,
    // and letting the renderer pick args would reopen the `-c "…"` RCE hole
    // `is_safe_shell_arg` closes.
    let args = shell
        .as_deref()
        .and_then(resolve_shell)
        .map(|discovered| discovered.args)
        .unwrap_or_default();
    let config = TerminalConfig {
        cwd: PathBuf::from(cwd),
        shell,
        args,
        env: HashMap::new(),
        cols,
        rows,
    };
    terminal_manager
        .spawn(config)
        .map_err(|e| IpcError::from(e.to_string()))
}

/// Write input bytes to a terminal session (base64-encoded from frontend).
#[tauri::command]
pub fn terminal_write(
    id: SessionId,
    data: String,
    terminal_manager: State<'_, Arc<TerminalManager>>,
) -> Result<(), IpcError> {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64;

    let bytes = BASE64.decode(&data).map_err(|e| e.to_string())?;
    terminal_manager
        .write(id, &bytes)
        .map_err(|e| e.to_string())
        .map_err(IpcError::from)
}

/// Resize a terminal session.
#[tauri::command]
pub fn terminal_resize(
    id: SessionId,
    cols: u16,
    rows: u16,
    terminal_manager: State<'_, Arc<TerminalManager>>,
) -> Result<(), IpcError> {
    terminal_manager
        .resize(id, cols, rows)
        .map_err(|e| e.to_string())
        .map_err(IpcError::from)
}

/// Kill a terminal session.
#[tauri::command]
pub fn terminal_kill(
    id: SessionId,
    terminal_manager: State<'_, Arc<TerminalManager>>,
) -> Result<(), IpcError> {
    terminal_manager
        .kill(id)
        .map_err(|e| IpcError::from(e.to_string()))
}

/// Set which terminal session is currently visible.
///
/// The process polling thread only polls the active session to minimize
/// syscalls. The frontend calls this when a terminal tab gains focus
/// (and again with `None` when it loses focus).
#[tauri::command]
pub fn terminal_set_active(
    id: Option<SessionId>,
    terminal_manager: State<'_, Arc<TerminalManager>>,
) -> Result<(), IpcError> {
    terminal_manager.set_active_session(id);
    Ok(())
}
