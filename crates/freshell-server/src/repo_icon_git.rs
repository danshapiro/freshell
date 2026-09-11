//! Repo-root resolution from a cwd via a pure filesystem `.git` walk.
//!
//! Port of the semantics of `server/coding-cli/utils.ts:169-245`
//! (`walkForGitRoot` / `resolveFromGitFile` / `resolveWorktreeRoot`):
//!
//! - `.git` directory: that dir is both checkout root and repo root
//! - `.git` file (worktree): checkout root = dir containing the `.git` file;
//!   repo root = parent of the shared `.git` dir (via `gitdir:` -> `commondir`)
//! - `.git` file (submodule, gitdir contains `/.git/modules/`):
//!   treated as an independent repo (both roots = that dir)
//! - no `.git` anywhere: both roots = the starting path
//!
//! No `git` subprocess is spawned (deliberate, matching the Node reference).

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub(crate) struct RepoInfo {
    pub checkout_root: PathBuf,
    pub repo_root: PathBuf,
}

/// Walk up from `start` looking for `.git`; see module docs for semantics.
pub(crate) fn resolve_repo(start: &Path) -> RepoInfo {
    let mut current = start.to_path_buf();
    loop {
        let git_path = current.join(".git");
        match std::fs::symlink_metadata(&git_path) {
            Ok(meta) if meta.is_dir() => {
                return RepoInfo {
                    checkout_root: current.clone(),
                    repo_root: current,
                };
            }
            Ok(meta) if meta.is_file() => {
                let repo_root =
                    resolve_from_git_file(&current, &git_path).unwrap_or_else(|| current.clone());
                return RepoInfo {
                    checkout_root: current,
                    repo_root,
                };
            }
            _ => {}
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => break,
        }
    }
    RepoInfo {
        checkout_root: start.to_path_buf(),
        repo_root: start.to_path_buf(),
    }
}

/// `.git` FILE handling: parse `gitdir:`; submodule -> independent repo;
/// worktree -> shared `.git` dir's parent via `commondir`; unknown -> the dir itself.
fn resolve_from_git_file(dot_git_dir: &Path, git_file: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(git_file).ok()?;
    let gitdir_raw = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    let gitdir = if Path::new(gitdir_raw).is_absolute() {
        PathBuf::from(gitdir_raw)
    } else {
        dot_git_dir.join(gitdir_raw)
    };
    let gitdir_str = gitdir.to_string_lossy().replace('\\', "/");
    if gitdir_str.contains("/.git/modules/") {
        return Some(dot_git_dir.to_path_buf());
    }
    if gitdir_str.contains("/.git/worktrees/") {
        let commondir_content = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
        let common = gitdir.join(commondir_content.trim());
        // Canonicalize to collapse the relative `../..` commondir path.
        let common = std::fs::canonicalize(&common).ok()?;
        return common.parent().map(|p| p.to_path_buf());
    }
    Some(dot_git_dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn mkrepo(dir: &std::path::Path) {
        fs::create_dir_all(dir.join(".git")).unwrap();
    }

    #[test]
    fn plain_repo_root_from_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("myrepo");
        mkrepo(&repo);
        let sub = repo.join("src").join("deep");
        fs::create_dir_all(&sub).unwrap();
        let info = resolve_repo(&sub);
        assert_eq!(info.repo_root, repo);
        assert_eq!(info.checkout_root, repo);
    }

    #[test]
    fn no_git_falls_back_to_start() {
        // The configured TMPDIR can itself be a Git worktree on developer
        // machines. Use the system temporary root for this no-ancestor-repo
        // case so the fixture's premise is explicit rather than ambient.
        let tmp = tempfile::tempdir_in("/tmp").unwrap();
        let dir = tmp.path().join("plain");
        fs::create_dir_all(&dir).unwrap();
        assert!(dir.ancestors().all(|path| !path.join(".git").exists()));
        let info = resolve_repo(&dir);
        assert_eq!(info.repo_root, dir);
        assert_eq!(info.checkout_root, dir);
    }

    #[test]
    fn worktree_resolves_repo_root_via_commondir() {
        let tmp = tempfile::tempdir().unwrap();
        let main_repo = tmp.path().join("mainrepo");
        mkrepo(&main_repo);
        let wt_gitdir = main_repo.join(".git").join("worktrees").join("wt1");
        fs::create_dir_all(&wt_gitdir).unwrap();
        // commondir points (relatively) back at the shared .git dir
        fs::write(wt_gitdir.join("commondir"), "../..\n").unwrap();
        let worktree = tmp.path().join("wt1");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", wt_gitdir.display()),
        )
        .unwrap();
        let info = resolve_repo(&worktree);
        assert_eq!(info.checkout_root, worktree);
        // Canonicalize both sides: commondir resolution canonicalizes.
        assert_eq!(info.repo_root, std::fs::canonicalize(&main_repo).unwrap());
    }

    #[test]
    fn submodule_stays_independent_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path().join("outer");
        mkrepo(&outer);
        let sub_gitdir = outer.join(".git").join("modules").join("sub");
        fs::create_dir_all(&sub_gitdir).unwrap();
        let sub = outer.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(
            sub.join(".git"),
            format!("gitdir: {}\n", sub_gitdir.display()),
        )
        .unwrap();
        let info = resolve_repo(&sub);
        assert_eq!(info.repo_root, sub);
        assert_eq!(info.checkout_root, sub);
    }

    #[test]
    fn malformed_git_file_treats_dir_as_root() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("weird");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".git"), "not a gitdir line\n").unwrap();
        let info = resolve_repo(&dir);
        assert_eq!(info.repo_root, dir);
        assert_eq!(info.checkout_root, dir);
    }
}
