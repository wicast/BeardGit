//! Shell detection and discovery for the current platform.
//!
//! Reads `$SHELL` on macOS/Linux. On Windows, reads `ComSpec` env var
//! with fallback to `powershell.exe`.
//!
//! [`available_shells`] additionally enumerates the shells the terminal
//! picker can offer, so a user can open cmd / pwsh / Git Bash / … explicitly
//! instead of always getting the system default.

use std::path::PathBuf;

use crate::types::{ShellOption, TerminalError};

/// Detect the system default shell.
///
/// Returns the shell path as a string (e.g. `/bin/zsh`, `powershell.exe`).
pub fn detect_shell() -> Result<String, TerminalError> {
    detect_shell_inner()
}

#[cfg(unix)]
fn detect_shell_inner() -> Result<String, TerminalError> {
    std::env::var("SHELL").map_err(|_| TerminalError::NoShellDetected)
}

#[cfg(windows)]
fn detect_shell_inner() -> Result<String, TerminalError> {
    std::env::var("ComSpec")
        .or_else(|_| {
            // Try powershell as fallback
            let ps = "powershell.exe";
            if which(ps).is_some() {
                Ok(ps.to_string())
            } else {
                Err(std::env::VarError::NotPresent)
            }
        })
        .map_err(|_| TerminalError::NoShellDetected)
}

/// Shells the terminal picker can offer, in menu order.
///
/// Only binaries that actually exist are returned, so the UI never offers a
/// shell that would fail to spawn. Paths come from fixed system locations and
/// `PATH` — never from the IPC payload — which is what lets
/// `manager::validate_shell` treat anything in this list as trusted.
pub fn available_shells() -> Vec<ShellOption> {
    discover_shells()
}

/// Look up a discovered shell by path, to re-apply its launch args.
///
/// Returns `None` for anything this host did not report, which is how
/// `validate_shell` rejects a renderer-invented path.
pub fn resolve_shell(path: &str) -> Option<ShellOption> {
    discover_shells()
        .into_iter()
        .find(|shell| same_path(&shell.path, path))
}

/// Append `path` to the list when it points at a real file and isn't a
/// duplicate of an entry already there.
fn push_existing(out: &mut Vec<ShellOption>, kind: &str, path: Option<PathBuf>, args: &[&str]) {
    let Some(path) = path else { return };
    if !path.is_file() {
        return;
    }
    let path = path.to_string_lossy().into_owned();
    if out.iter().any(|shell| same_path(&shell.path, &path)) {
        return;
    }
    out.push(ShellOption {
        kind: kind.to_string(),
        path,
        args: args.iter().map(|arg| arg.to_string()).collect(),
    });
}

/// First `PATH` entry holding `name`, or `None` when it isn't installed.
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Windows paths are case-insensitive, so `C:\…\cmd.exe` and `c:\…\cmd.exe`
/// must match — the picker round-trips our own string today, but a path
/// persisted in `settings.json` would not.
fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

#[cfg(windows)]
fn discover_shells() -> Vec<ShellOption> {
    let mut out = Vec::new();

    let comspec = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .or_else(|| which("cmd.exe"));
    push_existing(&mut out, "cmd", comspec, &[]);

    let powershell = system_root()
        .map(|root| {
            root.join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        })
        .or_else(|| which("powershell.exe"));
    push_existing(&mut out, "powershell", powershell, &[]);

    let pwsh = program_files()
        .map(|base| base.join("PowerShell").join("7").join("pwsh.exe"))
        .filter(|path| path.is_file())
        .or_else(|| which("pwsh.exe"));
    push_existing(&mut out, "pwsh", pwsh, &[]);

    // `--login -i` is what Git Bash's own shortcut passes; without it the
    // MSYS runtime skips the profile that sets up `/usr/bin` on PATH.
    push_existing(&mut out, "git-bash", git_bash(), &["--login", "-i"]);

    // `wsl.exe` is deliberately not offered: it is a distro launcher, not a
    // shell, and on a machine with no distro installed the entry could only
    // ever produce an error message. Adding it means first detecting that a
    // distro exists.
    out
}

/// Git for Windows keeps the MSYS `bash.exe` in `<root>\bin`, but the
/// `git.exe` that PATH resolves to may sit in `<root>\cmd`,
/// `<root>\mingw64\bin`, or `<root>\usr\bin` depending on the install. Walk
/// that binary's ancestors, then fall back to the standard machine-wide and
/// per-user install locations.
#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(git) = which("git.exe") {
        candidates.extend(
            git.ancestors()
                .take(4)
                .map(|root| root.join("bin").join("bash.exe")),
        );
    }
    if let Some(base) = program_files() {
        candidates.push(base.join("Git").join("bin").join("bash.exe"));
    }
    if let Some(base) = std::env::var_os("LocalAppData").map(PathBuf::from) {
        candidates.push(
            base.join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates.into_iter().find(|bash| bash.is_file())
}

#[cfg(windows)]
fn system_root() -> Option<PathBuf> {
    std::env::var_os("SystemRoot").map(PathBuf::from)
}

#[cfg(windows)]
fn program_files() -> Option<PathBuf> {
    std::env::var_os("ProgramFiles").map(PathBuf::from)
}

#[cfg(unix)]
fn discover_shells() -> Vec<ShellOption> {
    let mut paths = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        paths.push(PathBuf::from(shell));
    }
    // `/etc/shells` is the same allowlist `validate_shell` consults, so every
    // entry the picker offers is one the spawner will accept.
    if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
        paths.extend(
            contents
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .map(PathBuf::from),
        );
    }

    let mut out = Vec::new();
    for path in paths {
        // Unix has no fixed set of shells to name, so the menu label is the
        // binary's own basename (`zsh`, `fish`, …).
        let kind = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "shell".to_string());
        push_existing(&mut out, &kind, Some(path), &[]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn detect_shell_returns_something() {
        let shell = detect_shell().expect("should detect a shell");
        assert!(!shell.is_empty(), "shell path should not be empty");
    }

    #[cfg(unix)]
    #[test]
    fn detect_shell_respects_env() {
        let original = std::env::var("SHELL").ok();
        unsafe { std::env::set_var("SHELL", "/usr/bin/fish") };
        let result = detect_shell().unwrap();
        assert_eq!(result, "/usr/bin/fish");
        if let Some(orig) = original {
            unsafe { std::env::set_var("SHELL", orig) };
        }
    }

    #[test]
    fn available_shells_only_reports_real_files() {
        for shell in available_shells() {
            assert!(
                Path::new(&shell.path).is_file(),
                "discovered shell {} does not exist",
                shell.path
            );
            assert!(!shell.kind.is_empty(), "shell kind should not be empty");
        }
    }

    #[test]
    fn available_shells_has_no_duplicate_paths() {
        let shells = available_shells();
        for (i, shell) in shells.iter().enumerate() {
            assert!(
                !shells[i + 1..]
                    .iter()
                    .any(|other| same_path(&other.path, &shell.path)),
                "duplicate shell path in picker: {}",
                shell.path
            );
        }
    }

    #[test]
    fn resolve_shell_round_trips_every_discovered_path() {
        for shell in available_shells() {
            let resolved = resolve_shell(&shell.path)
                .unwrap_or_else(|| panic!("resolve_shell missed {}", shell.path));
            assert_eq!(resolved.kind, shell.kind);
            assert_eq!(resolved.args, shell.args);
        }
    }

    #[test]
    fn resolve_shell_rejects_unknown_path() {
        assert!(resolve_shell("/definitely/not/a/shell").is_none());
    }

    #[test]
    fn detected_default_shell_is_in_the_picker() {
        // `validate_shell` accepts the detected default separately, so a
        // mismatch here is not a security hole — but it would mean the
        // picker's "Default shell" row names something the list omits.
        let detected = detect_shell().expect("should detect a shell");
        // Windows' `detect_shell` fallback is the bare name `powershell.exe`
        // when `ComSpec` is missing, which discovery can't be expected to match.
        if Path::new(&detected).is_absolute() {
            assert!(
                resolve_shell(&detected).is_some(),
                "detected default {detected} is not offered by the picker"
            );
        }
    }

    #[test]
    fn push_existing_skips_missing_and_duplicate() {
        let mut out = Vec::new();
        push_existing(
            &mut out,
            "nope",
            Some(PathBuf::from("/definitely/not/here")),
            &[],
        );
        assert!(out.is_empty());

        let real = available_shells()
            .first()
            .expect("need one real shell")
            .clone();
        push_existing(&mut out, "first", Some(PathBuf::from(&real.path)), &["-l"]);
        push_existing(&mut out, "second", Some(PathBuf::from(&real.path)), &["-i"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "first");
        assert_eq!(out[0].args, ["-l"]);
    }

    #[cfg(windows)]
    #[test]
    fn git_bash_uses_the_msys_wrapper() {
        // `bin\bash.exe` sets up the MSYS runtime; `usr\bin\bash.exe` does
        // not, so offering the latter would give a broken interactive shell.
        if let Some(shell) = available_shells()
            .into_iter()
            .find(|s| s.kind == "git-bash")
        {
            let path = shell.path.to_ascii_lowercase();
            assert!(path.ends_with("\\bin\\bash.exe"), "unexpected path {path}");
            assert_eq!(shell.args, ["--login", "-i"]);
        }
    }
}
