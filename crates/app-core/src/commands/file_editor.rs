//! File-editor commands: workdir CRUD + binary-aware reads with a size cap.
//!
//! All paths arriving from the frontend are repo-relative, forward-slashed.
//! The underlying `git_engine` helpers reject absolute paths, `..`
//! segments, and anything that resolves outside the working tree.
//!
//! Reads cap text content at 2 MB. Larger files return
//! [`ReadWorkdirFileResult::TooLarge`] without reading their contents into
//! memory; binary files (NUL byte in the first 8 KB) return
//! [`ReadWorkdirFileResult::Binary`]. Image files return
//! [`ReadWorkdirFileResult::Image`] carrying only the absolute path — no
//! file bytes cross the IPC boundary. The frontend turns that path into an
//! asset URL with `convertFileSrc` and the webview loads it from disk.
//!
//! Every mutating command runs inside [`with_mutation_guard`] with
//! [`MutationKind::StagingChange`] so the watcher fan-out fires once on
//! success — `StagingChange` is the right fit for "the index or worktree
//! changed without touching refs", which covers writes / creates /
//! renames / deletes from the editor.

use std::io::Read;
use std::path::Path;

use mutation_events::MutationKind;
use tauri::{AppHandle, Manager, State};
use tracing::instrument;

use super::helpers::*;
use crate::ipc_error::IpcError;
use crate::state::AppState;

/// Soft cap on workdir reads. Files larger than this return
/// [`ReadWorkdirFileResult::TooLarge`] without their content; the editor
/// surfaces a "file too large to edit here" placeholder instead.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// Whether `path` looks like an image the editor should preview.
///
/// Detection is by extension only. The webview decodes the file itself
/// from its asset URL, so the backend merely needs to keep this file from
/// being dismissed by the NUL-byte binary sniff — it never reads the bytes.
/// SVG is included; loaded through `<img>` it does not execute scripts.
fn is_image_path(path: &str) -> bool {
    let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "tif" | "tiff" | "svg"
    )
}

/// Tagged result for [`read_workdir_file`].
///
/// Four terminal shapes:
/// - `Text { data, size }` – the file is plain UTF-8(ish) and fits the cap.
/// - `Image { path, size }` – extension looks like an image; `path` is the
///   absolute on-disk path for the frontend to load via the asset protocol.
/// - `Binary { size }` – first 8 KB contained a NUL byte.
/// - `TooLarge { size }` – exceeds [`MAX_READ_BYTES`]; content not loaded.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReadWorkdirFileResult {
    /// Plain text content. Lossy UTF-8 decode of the on-disk bytes.
    Text {
        /// File content as a string (lossy UTF-8).
        data: String,
        /// File size in bytes.
        size: u64,
    },
    /// An image to preview. No bytes are returned — the frontend loads the
    /// file directly from disk through Tauri's asset protocol.
    Image {
        /// Absolute path on disk, already validated to be inside the repo.
        path: String,
        /// File size in bytes.
        size: u64,
    },
    /// File is binary (NUL byte in the first 8 KB). Content not returned.
    Binary {
        /// File size in bytes.
        size: u64,
    },
    /// File exceeds [`MAX_READ_BYTES`]. Content not loaded into memory.
    TooLarge {
        /// File size in bytes.
        size: u64,
    },
}

/// Read a working-directory file, binary-aware and capped.
///
/// Returns one of the four [`ReadWorkdirFileResult`] variants. The size is
/// read first via `metadata()` so an oversized file is rejected without
/// ever loading its bytes. Images are detected before the binary sniff and
/// only their path is returned, so no file bytes cross the IPC boundary.
#[tauri::command]
#[instrument(skip(state, app), name = "cmd::file_editor::read_workdir_file")]
pub fn read_workdir_file(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ReadWorkdirFileResult, IpcError> {
    with_active_repo(&state, |repo| {
        let full = git_engine::file_content::validate_repo_relative_path(repo.path(), &path)
            .map_err(|e| e.to_string())?;
        if is_image_path(&path) {
            // Grant the webview access to this one file (not the whole
            // directory) so `convertFileSrc` can load it. Idempotent.
            app.asset_protocol_scope()
                .allow_file(&full)
                .map_err(|e| e.to_string())?;
        }
        read_file_result(&full, &path).map_err(IpcError::from)
    })
}

/// Shared body of [`read_workdir_file`], split out so the unit tests can
/// drive the exact same logic without constructing a live `AppState`.
fn read_file_result(full: &Path, path: &str) -> Result<ReadWorkdirFileResult, String> {
    let meta = std::fs::metadata(full).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {path}"));
    }
    let size = meta.len();

    // Image previews first: a PNG would otherwise be caught by the NUL-byte
    // binary sniff and shown as an uneditable placeholder. Only the path
    // goes back — the webview loads the bytes itself via the asset protocol,
    // so there is no size cap and nothing to serialise over IPC.
    if is_image_path(path) {
        return Ok(ReadWorkdirFileResult::Image {
            path: full.to_string_lossy().into_owned(),
            size,
        });
    }

    if size > MAX_READ_BYTES {
        return Ok(ReadWorkdirFileResult::TooLarge { size });
    }

    // Binary sniff on the first 8 KB before slurping the whole file.
    // We do this directly here (rather than going through
    // `Repository::get_file_workdir`) so the size we report and the
    // bytes we sniff come from the same `metadata()` call.
    let mut file = std::fs::File::open(full).map_err(|e| e.to_string())?;
    let mut head = [0u8; 8192];
    let read_n = file.read(&mut head).map_err(|e| e.to_string())?;
    if head[..read_n].contains(&0u8) {
        return Ok(ReadWorkdirFileResult::Binary { size });
    }

    // Re-open + read the full content. (We can't simply continue
    // reading into a buffer because we might already have consumed
    // some bytes for the sniff and the resulting concatenation gets
    // awkward to express atomically; a fresh open is clearer.)
    let bytes = std::fs::read(full).map_err(|e| e.to_string())?;
    let data = String::from_utf8_lossy(&bytes).into_owned();
    Ok(ReadWorkdirFileResult::Text { data, size })
}

/// Write `content` to a working-directory file (atomic replace).
///
/// Wraps the work in a [`MutationGuard`][mutation_events::MutationGuard]
/// scope so a successful write emits `project-mutated` with
/// [`MutationKind::StagingChange`].
#[tauri::command]
#[instrument(
    skip(state, app, content),
    name = "cmd::file_editor::write_workdir_file"
)]
pub fn write_workdir_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), IpcError> {
    with_mutation_guard(&state, &app, MutationKind::StagingChange, || {
        with_active_repo(&state, |repo| {
            repo.write_file_workdir(&path, &content)
                .map_err(IpcError::from)
        })
    })
}

/// List one level of the working directory.
///
/// See [`git_engine::Repository::list_workdir_tree`] for full semantics.
/// `prefix` is repo-relative; `None` lists the repo root.
#[tauri::command]
#[instrument(skip(state), name = "cmd::file_editor::list_workdir_tree")]
pub fn list_workdir_tree(
    prefix: Option<String>,
    max_entries: u32,
    respect_gitignore: bool,
    state: State<'_, AppState>,
) -> Result<Vec<git_engine::WorkdirTreeEntry>, IpcError> {
    with_active_repo(&state, |repo| {
        let entries = repo
            .list_workdir_tree(prefix.as_deref(), max_entries as usize, respect_gitignore)
            .map_err(|e| e.to_string())?;
        // Reaching the cap now means one directory holds more children than
        // it, not that the tree was cut short. Log the counts either way,
        // never the entry paths.
        tracing::debug!(
            prefix = prefix.as_deref().unwrap_or(""),
            max_entries,
            respect_gitignore,
            returned = entries.len(),
            capped = entries.len() >= max_entries as usize,
            "workdir tree listed"
        );
        Ok(entries)
    })
}

/// Find files anywhere in the working directory whose path contains `query`.
///
/// The tree lists one level at a time, so a filter that only looked at what
/// had been expanded could not see the file the user is typing the name of.
/// See [`git_engine::Repository::search_workdir_files`].
#[tauri::command]
#[instrument(
    skip_all,
    fields(limit, respect_gitignore),
    name = "cmd::file_editor::search_workdir_files"
)]
pub async fn search_workdir_files(
    query: String,
    limit: u32,
    respect_gitignore: bool,
    state: State<'_, AppState>,
) -> Result<Vec<git_engine::WorkdirTreeEntry>, IpcError> {
    // `async` matters more here than anywhere else in this file: the search
    // walks the whole working tree (16–30 ms on this repo) and the UI calls it
    // per keystroke. As a non-async command that walk ran on the main thread,
    // so every character typed cost a frame.
    let repo_path = get_active_project_path(&state)?;
    run_blocking(move || {
        let repo = git_engine::Repository::open(repo_path)?;
        let hits = repo
            .search_workdir_files(&query, limit as usize, respect_gitignore)
            .map_err(IpcError::from)?;
        // `skip_all` plus explicit fields above: the query is user prose and
        // has no business in a span field, and neither do the paths it
        // matched. The count is the useful part.
        tracing::debug!(matched = hits.len(), "workdir search");
        Ok(hits)
    })
    .await
}

/// Create a new file or directory at `path`. Errors if `path` already
/// exists. Mutating: emits a `staging_change` mutation event.
#[tauri::command]
#[instrument(skip(state, app), name = "cmd::file_editor::create_workdir_path")]
pub fn create_workdir_path(
    path: String,
    is_directory: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), IpcError> {
    with_mutation_guard(&state, &app, MutationKind::StagingChange, || {
        with_active_repo(&state, |repo| {
            repo.create_workdir_path(&path, is_directory)
                .map_err(IpcError::from)
        })
    })
}

/// Rename a file or directory. Errors if the source does not exist or
/// the destination already exists. Mutating: emits a `staging_change`
/// mutation event.
#[tauri::command]
#[instrument(skip(state, app), name = "cmd::file_editor::rename_workdir_path")]
pub fn rename_workdir_path(
    from_path: String,
    to_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), IpcError> {
    with_mutation_guard(&state, &app, MutationKind::StagingChange, || {
        with_active_repo(&state, |repo| {
            repo.rename_workdir_path(&from_path, &to_path)
                .map_err(IpcError::from)
        })
    })
}

/// Delete a file or directory. Errors if the path does not exist.
/// Mutating: emits a `staging_change` mutation event.
#[tauri::command]
#[instrument(skip(state, app), name = "cmd::file_editor::delete_workdir_path")]
pub fn delete_workdir_path(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), IpcError> {
    with_mutation_guard(&state, &app, MutationKind::StagingChange, || {
        with_active_repo(&state, |repo| {
            repo.delete_workdir_path(&path).map_err(IpcError::from)
        })
    })
}

#[cfg(test)]
mod tests {
    //! Unit tests for the file-editor module.
    //!
    //! These exercise the underlying `git_engine` repo methods rather
    //! than the Tauri commands themselves — the commands are thin
    //! `with_active_repo` / `with_mutation_guard` wrappers, and
    //! constructing a real `State<AppState>` in a unit test is more
    //! plumbing than signal. The end-to-end shape is covered by the
    //! Vitest spec on the TS wrappers + the `git-engine` tests.
    use super::{MAX_READ_BYTES, ReadWorkdirFileResult, is_image_path};
    use git_engine::Repository;
    use git_engine::test_support::create_repo_with_n_commits;
    use std::fs;

    /// Drive the exact same read body the command uses — the only part a
    /// unit test cannot reach through a live `AppState` is path validation.
    fn read_helper(repo: &Repository, path: &str) -> Result<ReadWorkdirFileResult, String> {
        let full = git_engine::file_content::validate_repo_relative_path(repo.path(), path)
            .map_err(|e| e.to_string())?;
        super::read_file_result(&full, path)
    }

    #[test]
    fn round_trip_write_then_read_text() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        let repo = Repository::open(&path).unwrap();
        repo.write_file_workdir("notes.md", "# hello\n").unwrap();
        let result = read_helper(&repo, "notes.md").unwrap();
        match result {
            ReadWorkdirFileResult::Text { data, size } => {
                assert_eq!(data, "# hello\n");
                assert_eq!(size, b"# hello\n".len() as u64);
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn read_returns_binary_for_files_with_nul_byte() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        fs::write(path.join("blob.bin"), [0x89, b'P', b'N', b'G', 0x00, 0x01]).unwrap();
        let repo = Repository::open(&path).unwrap();
        let result = read_helper(&repo, "blob.bin").unwrap();
        assert!(
            matches!(result, ReadWorkdirFileResult::Binary { .. }),
            "expected Binary, got {result:?}"
        );
    }

    #[test]
    fn read_returns_too_large_for_oversized_files() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        // Just over the cap.
        let big = vec![b'a'; (MAX_READ_BYTES as usize) + 1];
        fs::write(path.join("huge.txt"), &big).unwrap();
        let repo = Repository::open(&path).unwrap();
        let result = read_helper(&repo, "huge.txt").unwrap();
        match result {
            ReadWorkdirFileResult::TooLarge { size } => {
                assert_eq!(size, (MAX_READ_BYTES) + 1);
            }
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }

    #[test]
    fn is_image_path_maps_common_formats() {
        for name in [
            "a/logo.png",
            "a/photo.jpg",
            "a/photo.jpeg",
            "a/anim.gif",
            "a/pic.webp",
            "a/pic.bmp",
            "a/fav.ico",
            "a/pic.avif",
            "a/scan.tiff",
            "a/vec.svg",
        ] {
            assert!(is_image_path(name), "expected image: {name}");
        }
    }

    #[test]
    fn is_image_path_is_case_insensitive() {
        assert!(is_image_path("a/LOGO.PNG"));
        assert!(is_image_path("a/Photo.JpEg"));
    }

    #[test]
    fn is_image_path_rejects_non_images() {
        for name in ["a/notes.txt", "a/blob.bin", "a/Makefile", "a/unknown.xyz"] {
            assert!(!is_image_path(name), "expected non-image: {name}");
        }
    }

    #[test]
    fn read_returns_image_path_without_file_bytes() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        // NUL bytes on purpose: an image must be recognised before the
        // binary sniff, otherwise a PNG would fall through to `Binary`.
        let bytes = vec![0x89u8, b'P', b'N', b'G', 0x00, 0x00, 0x0d, 0x0a];
        fs::write(path.join("logo.png"), &bytes).unwrap();
        let repo = Repository::open(&path).unwrap();
        match read_helper(&repo, "logo.png").unwrap() {
            // The variant has no `data` field at all — file bytes never
            // leave the backend. Only the absolute path is returned.
            ReadWorkdirFileResult::Image { path, size } => {
                assert!(path.ends_with("logo.png"), "got {path}");
                assert_eq!(size, bytes.len() as u64);
            }
            other => panic!("expected Image, got {other:?}"),
        }
    }

    #[test]
    fn read_returns_image_path_for_svg() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        fs::write(path.join("icon.svg"), "<svg></svg>").unwrap();
        let repo = Repository::open(&path).unwrap();
        let result = read_helper(&repo, "icon.svg").unwrap();
        assert!(
            matches!(result, ReadWorkdirFileResult::Image { .. }),
            "expected Image, got {result:?}"
        );
    }

    #[test]
    fn oversized_image_is_still_a_preview() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        // Well past the text cap. No bytes are read any more, so there is
        // no image cap — the webview streams it from disk itself.
        let big = vec![0u8; (MAX_READ_BYTES as usize) + 1];
        fs::write(path.join("huge.png"), &big).unwrap();
        let repo = Repository::open(&path).unwrap();
        let result = read_helper(&repo, "huge.png").unwrap();
        assert!(
            matches!(result, ReadWorkdirFileResult::Image { .. }),
            "expected Image, got {result:?}"
        );
    }

    #[test]
    fn read_rejects_path_traversal() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        let repo = Repository::open(&path).unwrap();
        let err = read_helper(&repo, "../etc/passwd").unwrap_err();
        assert!(err.contains("invalid path") || err.contains(".."));
    }

    #[test]
    fn list_tree_happy_path() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        fs::write(path.join("a.txt"), "a").unwrap();
        let repo = Repository::open(&path).unwrap();
        let entries = repo.list_workdir_tree(None, 100, false).unwrap();
        assert!(entries.iter().any(|e| e.name == "a.txt"));
    }

    #[test]
    fn create_rename_delete_cycle() {
        let (_tmp, path) = create_repo_with_n_commits(1);
        let repo = Repository::open(&path).unwrap();

        repo.create_workdir_path("dir/inner.txt", false).unwrap();
        assert!(path.join("dir/inner.txt").is_file());

        repo.rename_workdir_path("dir/inner.txt", "dir/renamed.txt")
            .unwrap();
        assert!(!path.join("dir/inner.txt").exists());
        assert!(path.join("dir/renamed.txt").is_file());

        repo.delete_workdir_path("dir/renamed.txt").unwrap();
        assert!(!path.join("dir/renamed.txt").exists());
        // Containing directory remains.
        assert!(path.join("dir").is_dir());

        repo.delete_workdir_path("dir").unwrap();
        assert!(!path.join("dir").exists());
    }
}
