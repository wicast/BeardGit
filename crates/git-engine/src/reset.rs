//! Reset and amend operations.
//!
//! Extends [`Repository`] with `git reset` and `git commit --amend` support,
//! plus a helper to read the HEAD commit message for pre-filling amend UIs.

use tracing::instrument;

use crate::error::GitError;
use crate::repository::Repository;

impl Repository {
    /// Reset HEAD to a specific commit.
    ///
    /// # Parameters
    /// - `oid`  – Full or abbreviated SHA of the target commit.
    /// - `mode` – One of `"soft"`, `"mixed"`, or `"hard"`.
    ///
    /// # Errors
    /// Returns [`GitError::InvalidArgument`] for an unrecognised `mode`, or
    /// [`GitError::CliError`] when the underlying `git reset` invocation exits
    /// with a non-zero status.
    #[instrument(skip(self), fields(oid = %oid, mode = %mode))]
    pub fn reset_to_commit(&self, oid: &str, mode: &str) -> Result<(), GitError> {
        let flag = match mode {
            "soft" => "--soft",
            "mixed" => "--mixed",
            "hard" => "--hard",
            _ => {
                return Err(GitError::InvalidArgument(format!(
                    "Invalid reset mode: {mode}"
                )));
            }
        };
        // NOTE: `git reset` cannot use a `--` separator before the commit —
        // `git reset <flag> -- <x>` switches to path-reset mode and treats `x`
        // as a pathspec. The oid here is always a commit SHA resolved by the
        // frontend (never a leading-dash value), so option-injection is a
        // non-issue for this command.
        let result = self.git_cmd(&["reset", flag, oid])?;
        if result.success {
            Ok(())
        } else {
            Err(GitError::CliError(result.stderr))
        }
    }

    /// Amend the most recent commit with a new message.
    ///
    /// Any changes currently staged in the index are included in the amended
    /// commit, mirroring the behaviour of `git commit --amend -m <message>`.
    ///
    /// # Parameters
    /// - `message` – The replacement commit message.
    ///
    /// Amending already goes through the git CLI, so when `commit.gpgsign`
    /// is enabled the amended commit is signed automatically (git honors the
    /// config). The call is non-interactive so a locked key fails fast rather
    /// than hanging on a passphrase prompt.
    ///
    /// # Errors
    /// Returns [`GitError::SigningFailed`] when signing is enabled and the
    /// amend fails (so the UI can show the signing stderr), otherwise
    /// [`GitError::CliError`] (nothing to amend, detached HEAD, etc.).
    #[instrument(skip_all, fields(repo = %self.path().display()))]
    pub fn amend_commit(&self, message: &str) -> Result<(), GitError> {
        self.amend_commit_cli(message)
    }

    /// Return the commit message of the current HEAD commit.
    ///
    /// Useful for pre-filling an amend dialog with the existing message.
    ///
    /// # Errors
    /// Returns a [`GitError::Git`] when HEAD cannot be resolved or the commit
    /// object cannot be loaded.
    pub fn get_head_message(&self) -> Result<String, GitError> {
        let head = self.inner().head()?;
        let commit = head.peel_to_commit()?;
        Ok(commit.message().unwrap_or("").to_string())
    }

    /// Soft-reset HEAD by one commit, keeping the index and worktree intact.
    ///
    /// Returns the undone commit's message so the UI can pre-fill the commit
    /// box. This is the "undo last commit" path: the previous commit's files
    /// stay staged, the user edits the message, then a normal `create_commit`
    /// produces a replacement — no `--amend` involved.
    ///
    /// - With a parent: `git reset --soft HEAD^`.
    /// - First commit: deletes the branch HEAD points at so HEAD becomes
    ///   unborn; the index (staged changes) is left alone.
    ///
    /// # Errors
    /// Returns [`GitError::InvalidArgument`] when HEAD is unborn, or when the
    /// first commit is detached (there is no branch ref to drop).
    #[instrument(skip(self), fields(repo = %self.path().display()))]
    pub fn undo_last_commit(&self) -> Result<String, GitError> {
        let head = self.inner().head()?;
        let commit = head.peel_to_commit()?;
        let message = commit.message().unwrap_or("").to_string();

        if let Ok(parent) = commit.parent(0) {
            self.reset_to_commit(&parent.id().to_string(), "soft")?;
            return Ok(message);
        }

        // First commit: drop the branch ref so HEAD is unborn again. The
        // index still holds that commit's tree as staged changes.
        //
        // `Branch::delete` refuses when the branch is current HEAD, and
        // `git branch -d` does too — `git update-ref -d` is the supported
        // way to make HEAD unborn while leaving the index alone.
        let shorthand = head.shorthand().ok_or_else(|| {
            GitError::InvalidArgument(
                "HEAD is detached at the first commit; cannot undo".to_string(),
            )
        })?;
        let refname = format!("refs/heads/{shorthand}");
        let result = self.git_cmd(&["update-ref", "-d", &refname])?;
        if !result.success {
            return Err(GitError::CliError(result.stderr));
        }
        Ok(message)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::fs;

    use crate::repository::Repository;

    /// Initialise a temporary git repository with two commits and return an
    /// open [`Repository`] pointed at it.
    fn init_repo_with_commits(dir: &std::path::Path) -> Repository {
        let git_repo = git2::Repository::init(dir).unwrap();
        {
            let mut config = git_repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@test.com").unwrap();
        }

        // First commit
        let first_oid = {
            fs::write(dir.join("file.txt"), "first").unwrap();
            let mut index = git_repo.index().unwrap();
            index.add_path(std::path::Path::new("file.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = git_repo.find_tree(tree_id).unwrap();
            let sig = git_repo.signature().unwrap();
            git_repo
                .commit(Some("HEAD"), &sig, &sig, "first commit", &tree, &[])
                .unwrap()
        };

        // Second commit
        {
            fs::write(dir.join("file.txt"), "second").unwrap();
            let mut index = git_repo.index().unwrap();
            index.add_path(std::path::Path::new("file.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = git_repo.find_tree(tree_id).unwrap();
            let sig = git_repo.signature().unwrap();
            let first = git_repo.find_commit(first_oid).unwrap();
            git_repo
                .commit(Some("HEAD"), &sig, &sig, "second commit", &tree, &[&first])
                .unwrap();
        }

        drop(git_repo);
        Repository::open(dir).unwrap()
    }

    #[test]
    fn test_get_head_message() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo_with_commits(tmp.path());
        let msg = repo.get_head_message().unwrap();
        assert_eq!(msg.trim(), "second commit");
    }

    #[test]
    fn test_amend_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo_with_commits(tmp.path());
        repo.amend_commit("amended message").unwrap();
        let msg = repo.get_head_message().unwrap();
        assert_eq!(msg.trim(), "amended message");
    }

    #[test]
    fn test_reset_soft() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo_with_commits(tmp.path());
        let first_oid = {
            let head = repo.inner().head().unwrap().peel_to_commit().unwrap();
            head.parent(0).unwrap().id().to_string()
        };
        repo.reset_to_commit(&first_oid, "soft").unwrap();
        let msg = repo.get_head_message().unwrap();
        assert_eq!(msg.trim(), "first commit");
        // Working directory must still have the "second" content (soft reset
        // only moves HEAD; it does not touch the index or working tree).
        let content = fs::read_to_string(tmp.path().join("file.txt")).unwrap();
        assert_eq!(content, "second");
    }

    #[test]
    fn test_reset_hard() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo_with_commits(tmp.path());
        let first_oid = {
            let head = repo.inner().head().unwrap().peel_to_commit().unwrap();
            head.parent(0).unwrap().id().to_string()
        };
        repo.reset_to_commit(&first_oid, "hard").unwrap();
        let msg = repo.get_head_message().unwrap();
        assert_eq!(msg.trim(), "first commit");
        // Hard reset must restore the working-tree file to the first-commit content.
        let content = fs::read_to_string(tmp.path().join("file.txt")).unwrap();
        assert_eq!(content, "first");
    }

    #[test]
    fn test_reset_invalid_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo_with_commits(tmp.path());
        let result = repo.reset_to_commit("HEAD", "invalid");
        assert!(matches!(
            result,
            Err(crate::error::GitError::InvalidArgument(_))
        ));
    }

    #[test]
    fn test_undo_last_commit_soft_resets_to_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo_with_commits(tmp.path());
        let message = repo.undo_last_commit().unwrap();
        assert_eq!(message.trim(), "second commit");
        assert_eq!(repo.get_head_message().unwrap().trim(), "first commit");
        // Soft reset keeps the worktree at the undone commit's content.
        let content = fs::read_to_string(tmp.path().join("file.txt")).unwrap();
        assert_eq!(content, "second");
        // And the undone changes stay staged (index vs new HEAD).
        let staged = repo.diff_index().unwrap();
        assert!(
            !staged.is_empty(),
            "undo should leave the undone commit's files staged"
        );
    }

    #[test]
    fn test_undo_first_commit_leaves_head_unborn() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let git_repo = git2::Repository::init(tmp.path()).unwrap();
            let mut config = git_repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@test.com").unwrap();
            drop(config);
            fs::write(tmp.path().join("only.txt"), "content").unwrap();
            let mut index = git_repo.index().unwrap();
            index.add_path(std::path::Path::new("only.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = git_repo.find_tree(tree_id).unwrap();
            let sig = git_repo.signature().unwrap();
            git_repo
                .commit(Some("HEAD"), &sig, &sig, "first", &tree, &[])
                .unwrap();
        }
        let repo = Repository::open(tmp.path()).unwrap();
        let message = repo.undo_last_commit().unwrap();
        assert_eq!(message.trim(), "first");
        assert!(
            repo.get_head_message().is_err(),
            "HEAD should be unborn after undoing the first commit"
        );
        // Staged content from the undone commit must remain.
        let statuses = repo.file_statuses().unwrap();
        assert!(
            statuses.iter().any(|s| s.path == "only.txt" && s.is_staged),
            "first-commit content should still be staged"
        );
    }
}
