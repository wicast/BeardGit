//! High-level git write operations: committing, branching, and checking out.
//!
//! Commit and branch creation use `libgit2`. Checkout deliberately routes
//! through the system `git` CLI ([`Repository::git_cmd`]) instead: libgit2
//! does not load the repo's configured `filter.<name>.clean/smudge` filters
//! (its registry only knows the built-in CRLF/IDENT filters), so a libgit2
//! checkout would write git-lfs pointer blobs to the working tree verbatim.
//! The CLI runs the configured smudge filters, exactly like `git checkout`
//! from a terminal. For operations that libgit2 cannot handle at all (merge,
//! rebase, push, etc.) see the [`cli`](crate::cli) module.

// Operations module — commit, branch, checkout

use tracing::instrument;

use crate::error::GitError;
use crate::repository::Repository;

impl Repository {
    /// Create a commit from the current index state.
    ///
    /// Uses the repository's configured `user.name` and `user.email` from
    /// git config for the author and committer signature.
    ///
    /// When `commit.gpgsign` is enabled, creation is routed through the git
    /// CLI ([`Repository::create_commit_signed`]) so the user's ssh/gpg/x509
    /// signing config and agents are honored — `libgit2` cannot sign. With
    /// signing off, the byte-identical `git2` path below is used.
    #[instrument(skip_all, fields(repo = %self.path().display()))]
    pub fn create_commit(&self, message: &str) -> Result<String, GitError> {
        if self.signing_config()?.enabled {
            return self.create_commit_signed(message);
        }
        let repo = self.inner();
        let sig = repo.signature()?;
        let mut index = repo.index()?;
        // The staging commands write the index through the git CLI
        // (`git add`), and libgit2 caches the index on the Repository
        // handle — a handle that read the index before that CLI write
        // would otherwise build this commit's tree from the stale
        // entries. Force a re-read from disk first.
        index.read(true)?;
        let tree_id = index.write_tree()?;
        let tree = repo.find_tree(tree_id)?;

        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();

        let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
        Ok(oid.to_string())
    }

    /// Create a new branch at HEAD.
    #[instrument(skip(self), fields(branch = %name))]
    pub fn create_branch(&self, name: &str) -> Result<(), GitError> {
        let repo = self.inner();
        let head = repo.head()?.peel_to_commit()?;
        repo.branch(name, &head, false)?;
        Ok(())
    }

    /// Create a new branch at a specific commit.
    #[instrument(skip(self), fields(branch = %name, oid = %oid))]
    pub fn create_branch_at(&self, name: &str, oid: &str) -> Result<(), GitError> {
        let repo = self.inner();
        let obj = repo.revparse_single(oid)?;
        let commit = obj
            .peel_to_commit()
            .map_err(|_| GitError::Git(git2::Error::from_str("not a commit")))?;
        repo.branch(name, &commit, false)?;
        Ok(())
    }

    /// Delete a local branch by name.
    ///
    /// `force = false` runs `git branch -d <name>` and refuses to delete a
    /// branch that has unmerged commits — the safer default that matches
    /// the CLI. `force = true` runs `git branch -D <name>`, which deletes
    /// regardless of merge status.
    ///
    /// Both forms still refuse to delete a branch that is currently checked
    /// out (HEAD or in a linked worktree); to remove those, drop the
    /// worktree first via [`Self::remove_worktree`] (or the AI background
    /// "Discard worktree" affordance, which removes the worktree + branch
    /// together).
    ///
    /// Routes through the system `git` CLI rather than libgit2 so the
    /// merge-protection check actually fires — libgit2's `branch.delete()`
    /// is unconditional, which silently force-deletes unmerged work.
    #[instrument(skip(self), fields(branch = %name, force))]
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        let flag = if force { "-D" } else { "-d" };
        // `--` keeps a branch name beginning with `-` from being parsed as a flag.
        let result = self.git_cmd(&["branch", flag, "--", name])?;
        if result.success {
            Ok(())
        } else if result.stderr.contains("not fully merged") {
            // `git branch -d` refusing an unmerged branch is user-actionable
            // (re-run with force), so surface it as a distinct variant.
            Err(GitError::NotFullyMerged(result.stderr))
        } else {
            Err(GitError::CliError(result.stderr))
        }
    }

    /// Switch HEAD to an existing branch.
    ///
    /// Routes through the system `git` CLI rather than libgit2 because
    /// libgit2's filter registry contains only the built-in CRLF/IDENT
    /// filters — it never reads the `filter.<name>.clean/smudge/process`
    /// entries that `git lfs install` writes to the repo config. A libgit2
    /// checkout therefore writes LFS pointer blobs to the working tree
    /// verbatim, leaving every LFS-tracked file on the target branch as a
    /// ~130-byte text pointer until the user manually runs `git lfs
    /// checkout`. The CLI runs the configured smudge filters (downloading
    /// missing objects on demand), matching `git checkout` semantics.
    ///
    /// A safe checkout over a dirty working tree is refused by git — map it
    /// to the distinct [`GitError::WouldLoseChanges`] variant so the UI can
    /// tell the user to commit or stash first.
    #[instrument(skip(self), fields(branch = %name))]
    pub fn checkout_branch(&self, name: &str) -> Result<(), GitError> {
        // `git checkout` has no `--` form for the branch argument, so a name
        // starting with `-` would be parsed as an option. Reject it up front
        // instead of letting git misread it (or, worse, a name like
        // `--help` succeed as something else).
        if name.starts_with('-') {
            return Err(GitError::InvalidArgument(format!(
                "invalid branch name: {name}"
            )));
        }
        let result = self.git_cmd(&["checkout", name])?;
        if result.success {
            Ok(())
        } else if is_would_lose_changes(&result.stderr) {
            // Both the "local changes would be overwritten" and the
            // "untracked working tree files would be overwritten" refusals
            // contain this phrase — either way the user has to commit,
            // stash, or move files first.
            Err(GitError::WouldLoseChanges(result.stderr))
        } else {
            Err(GitError::CliError(result.stderr))
        }
    }

    /// Checkout a specific commit (detached HEAD).
    ///
    /// Uses the git CLI for the same filter reason as
    /// [`Self::checkout_branch`]: only the CLI runs the repo's configured
    /// smudge filters, so LFS-tracked files materialize to their real
    /// content instead of pointer text.
    #[instrument(skip(self), fields(oid = %oid))]
    pub fn checkout_detached(&self, oid: &str) -> Result<(), GitError> {
        if oid.starts_with('-') {
            return Err(GitError::InvalidArgument(format!(
                "invalid commit oid: {oid}"
            )));
        }
        let result = self.git_cmd(&["checkout", "--detach", oid])?;
        if result.success {
            Ok(())
        } else if is_would_lose_changes(&result.stderr) {
            Err(GitError::WouldLoseChanges(result.stderr))
        } else {
            Err(GitError::CliError(result.stderr))
        }
    }

    /// Return the short name of the current branch, or None if detached.
    pub fn get_current_branch(&self) -> Result<Option<String>, GitError> {
        let repo = self.inner();
        match repo.head() {
            // `is_branch()` is false for a detached HEAD, whose shorthand
            // is the literal "HEAD" rather than a branch name.
            Ok(head) if head.is_branch() => Ok(head.shorthand().map(String::from)),
            Ok(_) => Ok(None),
            Err(_) => Ok(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// True when a failed `git checkout` refused because the working tree holds
/// changes the checkout would clobber.
///
/// Covers both refusals git prints in that situation — modified tracked
/// files ("Your local changes to the following files would be overwritten by
/// checkout") and untracked files in the way ("The following untracked
/// working tree files would be overwritten by checkout") — so callers can
/// keep mapping them to [`GitError::WouldLoseChanges`] like the libgit2
/// conflict they replaced.
fn is_would_lose_changes(stderr: &str) -> bool {
    stderr.contains("would be overwritten by checkout")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn create_test_repo() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let git_repo = git2::Repository::init(dir.path()).unwrap();
        let mut config = git_repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@test.com").unwrap();
        let sig = git2::Signature::now("Test", "test@test.com").unwrap();
        let file_path = dir.path().join("file.txt");
        fs::write(&file_path, "content\n").unwrap();
        let mut index = git_repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = git_repo.find_tree(tree_id).unwrap();
        git_repo
            .commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
            .unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        (dir, repo)
    }

    // ── LFS filter round-trip ───────────────────────────────────────────
    //
    // libgit2 does not load the repo's configured `filter.lfs.*` entries,
    // so a checkout that bypasses the git CLI leaves LFS-tracked files as
    // pointer text on disk (and never downloads the objects). These pin
    // the CLI routing; they skip when git-lfs is not installed.

    fn lfs_fixture() -> Option<(tempfile::TempDir, std::path::PathBuf)> {
        crate::test_support::create_lfs_repo_with_fetched_branch()
    }

    #[test]
    fn checkout_branch_after_fetch_smudges_lfs_files() {
        let Some((_tmp, work)) = lfs_fixture() else {
            return;
        };

        // The reported flow: fetch (done by the fixture), then "New branch
        // from here" on the freshly fetched remote branch — create_branch_at
        // followed by checkout_branch.
        let remote_tip =
            crate::test_support::run_git_capture(&work, &["rev-parse", "origin/feature"]);
        let repo = Repository::open(&work).unwrap();
        repo.create_branch_at("feature", remote_tip.trim()).unwrap();
        repo.checkout_branch("feature").unwrap();

        let content = fs::read_to_string(work.join("asset.bin")).unwrap();
        assert_eq!(
            content,
            crate::test_support::LFS_FEATURE_CONTENT,
            "LFS-tracked file must be smudged to real content after checkout"
        );
    }

    #[test]
    fn checkout_detached_smudges_lfs_files() {
        let Some((_tmp, work)) = lfs_fixture() else {
            return;
        };

        let remote_tip =
            crate::test_support::run_git_capture(&work, &["rev-parse", "origin/feature"]);
        let repo = Repository::open(&work).unwrap();
        repo.checkout_detached(remote_tip.trim()).unwrap();

        let content = fs::read_to_string(work.join("asset.bin")).unwrap();
        assert_eq!(content, crate::test_support::LFS_FEATURE_CONTENT);
    }

    #[test]
    fn test_create_commit() {
        let (dir, repo) = create_test_repo();
        fs::write(dir.path().join("file.txt"), "updated\n").unwrap();
        repo.stage_files(&["file.txt".to_string()]).unwrap();
        let oid = repo.create_commit("Test commit").unwrap();
        assert!(!oid.is_empty());
        let commits = repo.walk_commits(0, 10).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].summary, "Test commit");
    }

    #[test]
    fn test_create_and_delete_branch() {
        let (_dir, repo) = create_test_repo();
        repo.create_branch("feature/test").unwrap();
        let branches = repo.branches().unwrap();
        assert!(branches.iter().any(|b| b.name == "feature/test"));

        repo.delete_branch("feature/test", false).unwrap();
        let branches = repo.branches().unwrap();
        assert!(!branches.iter().any(|b| b.name == "feature/test"));
    }

    #[test]
    fn test_delete_branch_unmerged_requires_force() {
        // `git branch -d` should refuse a branch with commits that aren't
        // reachable from HEAD; `-D` should still succeed. Mirrors the
        // CLI's safer default and the new force toggle in the UI.
        let (_dir, repo) = create_test_repo();
        repo.create_branch("feature/diverge").unwrap();
        repo.checkout_branch("feature/diverge").unwrap();

        // Drop a commit on the branch that HEAD's main line won't see.
        let path = repo.path();
        std::fs::write(path.join("diverge.txt"), "x").unwrap();
        repo.stage_files(&["diverge.txt".to_string()]).unwrap();
        repo.create_commit("on diverge").unwrap();

        // Move HEAD off the branch so we're allowed to delete it.
        repo.checkout_branch("main")
            .or_else(|_| repo.checkout_branch("master"))
            .expect("test repo must have a default branch");

        // Non-force should refuse with the distinct NotFullyMerged variant.
        let err = repo.delete_branch("feature/diverge", false).err();
        assert!(
            matches!(err, Some(GitError::NotFullyMerged(_))),
            "non-force delete must refuse an unmerged branch with NotFullyMerged, got {err:?}"
        );

        // Force escalates and succeeds.
        repo.delete_branch("feature/diverge", true)
            .expect("force delete must succeed for unmerged branches");
        let branches = repo.branches().unwrap();
        assert!(!branches.iter().any(|b| b.name == "feature/diverge"));
    }

    #[test]
    fn test_checkout_branch() {
        let (_dir, repo) = create_test_repo();
        repo.create_branch("develop").unwrap();
        repo.checkout_branch("develop").unwrap();
        let current = repo.get_current_branch().unwrap();
        assert_eq!(current, Some("develop".to_string()));
    }

    #[test]
    fn test_checkout_over_dirty_tree_reports_would_lose_changes() {
        // Switching branches with an uncommitted edit that the target branch
        // would overwrite must surface WouldLoseChanges, not a generic Git.
        let (dir, repo) = create_test_repo();
        repo.create_branch("develop").unwrap();

        // Diverge develop's copy of file.txt so checking it out would clobber
        // the working-tree edit below.
        repo.checkout_branch("develop").unwrap();
        fs::write(dir.path().join("file.txt"), "develop content\n").unwrap();
        repo.stage_files(&["file.txt".to_string()]).unwrap();
        repo.create_commit("develop edit").unwrap();

        repo.checkout_branch("main")
            .or_else(|_| repo.checkout_branch("master"))
            .expect("test repo must have a default branch");

        // Dirty the working tree so switching back would lose the edit.
        fs::write(dir.path().join("file.txt"), "uncommitted\n").unwrap();

        let err = repo.checkout_branch("develop").err();
        assert!(
            matches!(err, Some(GitError::WouldLoseChanges(_))),
            "dirty checkout must report WouldLoseChanges, got {err:?}"
        );
    }

    #[test]
    fn test_get_current_branch() {
        let (_dir, repo) = create_test_repo();
        let branch = repo.get_current_branch().unwrap();
        assert!(branch.is_some());
    }

    #[test]
    fn test_create_branch_at_commit() {
        let (dir, repo) = create_test_repo();
        let first_commits = repo.walk_commits(0, 1).unwrap();
        let first_oid = &first_commits[0].oid;

        // Create a second commit
        fs::write(dir.path().join("file.txt"), "updated\n").unwrap();
        repo.stage_files(&["file.txt".to_string()]).unwrap();
        repo.create_commit("Second commit").unwrap();

        // Create branch at the first commit
        repo.create_branch_at("old-branch", first_oid).unwrap();
        let branches = repo.branches().unwrap();
        assert!(branches.iter().any(|b| b.name == "old-branch"));
    }

    #[test]
    fn test_checkout_detached() {
        let (_dir, repo) = create_test_repo();
        let commits = repo.walk_commits(0, 1).unwrap();
        let oid = &commits[0].oid;

        repo.checkout_detached(oid).unwrap();
        // Detached HEAD is not a branch — shorthand would be the literal
        // "HEAD", which callers must not treat as a resolvable branch name.
        let branch = repo.get_current_branch().unwrap();
        assert!(branch.is_none(), "detached HEAD has no branch name");
    }

    #[test]
    fn test_checkout_detached_over_dirty_tree_reports_would_lose_changes() {
        // Detaching onto a commit whose tree would overwrite an uncommitted
        // edit must surface WouldLoseChanges, not a generic Git — mirroring
        // checkout_branch so the UI can prompt to commit or stash first.
        let (dir, repo) = create_test_repo();
        let first_oid = repo.walk_commits(0, 1).unwrap()[0].oid.clone();

        // A second commit diverges file.txt from the first commit's copy.
        fs::write(dir.path().join("file.txt"), "second commit\n").unwrap();
        repo.stage_files(&["file.txt".to_string()]).unwrap();
        repo.create_commit("second commit").unwrap();

        // Dirty the working tree so detaching back to the first commit would
        // clobber the edit.
        fs::write(dir.path().join("file.txt"), "uncommitted\n").unwrap();

        let err = repo.checkout_detached(&first_oid).err();
        assert!(
            matches!(err, Some(GitError::WouldLoseChanges(_))),
            "dirty detached checkout must report WouldLoseChanges, got {err:?}"
        );
    }
}
