//! Git metadata helpers — identical port of `server/coding-cli/utils.ts`
//! (roots walk :35-71/169-257, branch+dirty :93-116/151-167, caches :24-26)
//! plus the display-subdir derivation from `server/terminal-metadata-service.ts:43-53`.
//!
//! Algorithm (utils.ts:9-22):
//! 1. Normalize input (expand `~`, refuse relative paths).
//! 2. Walk up from cwd looking for a `.git` entry.
//! 3. `.git` valid directory -> regular repo root.
//! 4. `.git` file -> parse the `gitdir:` line:
//!    - `/.git/worktrees/` in gitdir -> read `commondir` to find the shared
//!      `.git` dir (repo mode); checkout mode keeps the worktree dir.
//!    - `/.git/modules/` in gitdir -> submodule, keep as independent repo.
//! 5. No `.git` found -> return the normalized cwd.
//! 6. On any error -> return the normalized cwd (and cache it — utils.ts:49).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

// Process-lifetime unbounded caches keyed by normalized cwd (utils.ts:24-26).
// Error results are cached too (utils.ts:49/68).
static REPO_ROOT_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CHECKOUT_ROOT_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `normalizeGitPathInput` (utils.ts:138-149): `~` -> home-resolved; absolute
/// -> resolved; RELATIVE -> None (resolving against the server cwd would lie).
/// Node's `os.homedir()` and `path.isAbsolute` are PLATFORM-AWARE — see
/// [`node_home_dir`] and [`node_is_absolute`].
pub fn normalize_git_path_input(cwd: &str) -> Option<PathBuf> {
    if let Some(stripped) = cwd.strip_prefix('~') {
        // Node: path.resolve(os.homedir(), cwd.slice(cwd.startsWith('~/') ? 2 : 1))
        let home = node_home_dir()?;
        let rest = stripped.strip_prefix('/').unwrap_or(stripped);
        return Some(lexical_resolve(&Path::new(&home).join(rest)));
    }
    if node_is_absolute(cwd) {
        return Some(lexical_resolve(Path::new(cwd)));
    }
    None
}

/// fs walk for `.git` (dir OR file). Worktree (`gitdir:` containing
/// `/.git/worktrees/`): repo mode follows `<gitdir>/commondir` up to the
/// PARENT repo root; checkout mode returns the dir holding the `.git` file.
/// Submodule (`/.git/modules/`): both modes return the dir holding `.git`.
/// Not a repo / any error -> the normalized cwd itself. Results cached
/// (process-lifetime, unbounded, keyed by normalized cwd — Node parity).
pub fn resolve_git_repo_root(cwd: &str) -> Option<String> {
    resolve_root_cached(cwd, Mode::Repo, &REPO_ROOT_CACHE)
}

/// Checkout-root variant of [`resolve_git_repo_root`] (utils.ts:54-71):
/// worktrees/submodules resolve to the directory containing the `.git` file
/// (utils.ts:189-193).
pub fn resolve_git_checkout_root(cwd: &str) -> Option<String> {
    resolve_root_cached(cwd, Mode::Checkout, &CHECKOUT_ROOT_CACHE)
}

/// Branch + dirty state for a checkout (utils.ts:93-116).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BranchAndDirty {
    pub branch: Option<String>,
    pub is_dirty: Option<bool>,
}

/// BLOCKING (spawns `git` up to three times: symbolic-ref, the rev-parse
/// fallback, status) — call via tokio spawn_blocking.
/// `git -C <checkoutRoot> symbolic-ref --short HEAD` -> fallback
/// `rev-parse --abbrev-ref HEAD`;
/// `git -C <checkoutRoot> --no-optional-locks status --porcelain`.
/// EVERY spawned git command sets `GIT_OPTIONAL_LOCKS=0` (env) or passes
/// `--no-optional-locks` (validator-A7): Node uses plain
/// `git status --porcelain` (server/coding-cli/utils.ts:102) but is
/// event-driven; the Task 18 throttled polling without this would
/// continually rewrite .git/index.
/// "no branch AND clean" -> Default() (is_dirty stays None — utils.ts:105-107);
/// any error -> Default(). NOT cached (Node parity).
///
/// Detached HEAD: `rev-parse --abbrev-ref HEAD` prints `HEAD` — returned
/// verbatim (Node does the same).
pub fn resolve_git_branch_and_dirty(cwd: &str) -> BranchAndDirty {
    let Some(normalized) = normalize_git_path_input(cwd) else {
        return BranchAndDirty::default();
    };
    let normalized = normalized.to_string_lossy().into_owned();
    // utils.ts:97 — resolveGitCheckoutRoot never fails for an absolute path.
    let checkout_root = resolve_git_checkout_root(&normalized).unwrap_or(normalized);

    let branch = resolve_git_branch(&checkout_root);
    // execFileAsync rejects on non-zero exit -> the whole call returns {} (utils.ts:113-115).
    let Some(status_stdout) = run_git(
        &checkout_root,
        &["--no-optional-locks", "status", "--porcelain"],
    ) else {
        return BranchAndDirty::default();
    };

    let dirty = !status_stdout.trim().is_empty();
    if branch.is_none() && !dirty {
        // "no branch AND clean" -> {} (utils.ts:105-107).
        return BranchAndDirty::default();
    }
    BranchAndDirty {
        branch,
        is_dirty: Some(dirty),
    }
}

/// basename(checkoutRoot || cwd) after stripping trailing separators
/// (terminal-metadata-service.ts:43-53). Node `path.basename` is
/// platform-dependent — see [`node_basename_split`].
pub fn derive_display_subdir(cwd: Option<&str>, checkout_root: Option<&str>) -> Option<String> {
    // JS `||`: an empty (fully-stripped) checkoutRoot falls through to cwd.
    let source = normalize_path_for_display(checkout_root)
        .filter(|s| !s.is_empty())
        .or_else(|| normalize_path_for_display(cwd).filter(|s| !s.is_empty()))?;
    let base = node_basename_split(&source, cfg!(windows)).to_string();
    // `base || source` (terminal-metadata-service.ts:52).
    if base.is_empty() {
        Some(source)
    } else {
        Some(base)
    }
}

/// Test hook mirroring `clearRepoRootCache` (utils.ts:29-33).
#[cfg(test)]
pub fn clear_git_meta_caches() {
    REPO_ROOT_CACHE.lock().unwrap().clear();
    CHECKOUT_ROOT_CACHE.lock().unwrap().clear();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Repo,
    Checkout,
}

/// Shared cache-then-walk body of `resolveGitRepoRoot` / `resolveGitCheckoutRoot`
/// (utils.ts:35-71). Any walk error resolves — and caches — the normalized cwd.
fn resolve_root_cached(
    cwd: &str,
    mode: Mode,
    cache: &Mutex<HashMap<String, String>>,
) -> Option<String> {
    let normalized = normalize_git_path_input(cwd)?;
    let key = normalized.to_string_lossy().into_owned();

    if let Some(cached) = cache.lock().unwrap().get(&key) {
        return Some(cached.clone());
    }

    let result = walk_for_git_root(&normalized, mode)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| key.clone());
    cache.lock().unwrap().insert(key, result.clone());
    Some(result)
}

/// `walkForGitRoot` (utils.ts:169-214). EVERY per-level fs error — the lstat
/// AND the `.git`-FILE read (utils.ts:194) — is inside Node's per-level
/// try/catch (utils.ts:203-205), so the walk keeps going up to the parent;
/// an enclosing repo root above can still be found. The caller's
/// normalized-cwd fallback remains only for genuinely unrecoverable cases.
fn walk_for_git_root(start_dir: &Path, mode: Mode) -> std::io::Result<PathBuf> {
    let mut current = start_dir.to_path_buf();

    loop {
        let git_path = current.join(".git");

        // lstat (utils.ts:177) — does not follow a `.git` symlink.
        if let Ok(meta) = std::fs::symlink_metadata(&git_path) {
            if meta.is_dir() {
                if !is_git_directory(&git_path) {
                    return Ok(start_dir.to_path_buf());
                }
                // Regular repo root.
                return Ok(current);
            }
            if meta.is_file() {
                // `.git` file — could be worktree or submodule.
                if mode == Mode::Checkout {
                    // Checkout-root semantics: the dir containing the .git file.
                    return Ok(current);
                }
                // Node's fsp.readFile sits INSIDE the per-level try/catch
                // (utils.ts:194, caught at :203-205): a read ERROR is treated
                // like "no .git here" — fall through and keep walking up.
                // Decoding is lossy, matching Node's readFile(…, 'utf-8').
                if let Ok(bytes) = std::fs::read(&git_path) {
                    let content = String::from_utf8_lossy(&bytes);
                    if let Some(gitdir_raw) = parse_gitdir_line(&content) {
                        // path.resolve(path.dirname(gitPath), match[1].trim())
                        let gitdir = lexical_resolve(&current.join(gitdir_raw));
                        return Ok(resolve_from_git_file(&current, &gitdir));
                    }
                    // Readable but gitdir-less/malformed .git file — treat
                    // this directory as the root (utils.ts:196-201): the walk
                    // does NOT continue past it.
                    return Ok(current);
                }
            }
            // Neither dir nor file (e.g. symlink), or unreadable .git file:
            // fall through and keep walking (utils.ts:203-205).
        }

        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => break, // filesystem root
        }
    }

    // No .git found anywhere.
    Ok(start_dir.to_path_buf())
}

/// `resolveFromGitFile` (utils.ts:216-232). Substring checks are anchored to
/// `/.git/modules/` and `/.git/worktrees/` to avoid false positives when the
/// repo path itself contains a `modules`/`worktrees` segment.
fn resolve_from_git_file(dot_git_dir: &Path, gitdir: &Path) -> PathBuf {
    let gitdir_str = gitdir.to_string_lossy();

    // Submodule: keep as independent repo.
    if gitdir_str.contains("/.git/modules/") || gitdir_str.contains("\\.git\\modules\\") {
        return dot_git_dir.to_path_buf();
    }

    // Worktree: collapse to the parent repository root.
    if gitdir_str.contains("/.git/worktrees/") || gitdir_str.contains("\\.git\\worktrees\\") {
        return resolve_worktree_root(dot_git_dir, gitdir);
    }

    // Unknown layout — treat as repo root.
    dot_git_dir.to_path_buf()
}

/// `resolveWorktreeRoot` (utils.ts:234-257): `<gitdir>/commondir` is the
/// canonical route (its content resolves to the shared `.git` dir; the repo
/// root is that dir's parent). Fallback heuristic: `.../.git/worktrees/<name>`.
fn resolve_worktree_root(dot_git_dir: &Path, gitdir: &Path) -> PathBuf {
    if let Ok(commondir_content) = std::fs::read_to_string(gitdir.join("commondir")) {
        let common_dir = lexical_resolve(&gitdir.join(commondir_content.trim()));
        // path.dirname('/') === '/' — parent of the root stays the root.
        return match common_dir.parent() {
            Some(parent) => parent.to_path_buf(),
            None => common_dir,
        };
    }

    // Heuristic: gitdir matches .../.git/worktrees/<name> — walk up 3 levels.
    let comps: Vec<Component> = gitdir.components().collect();
    if let Some(idx) = comps
        .iter()
        .rposition(|c| c.as_os_str() == std::ffi::OsStr::new("worktrees"))
    {
        if idx >= 2 && comps[idx - 1].as_os_str() == std::ffi::OsStr::new(".git") {
            let mut out = PathBuf::new();
            for comp in &comps[..idx - 1] {
                out.push(comp.as_os_str());
            }
            if !out.as_os_str().is_empty() {
                return out;
            }
            return PathBuf::from(std::path::MAIN_SEPARATOR.to_string());
        }
    }

    dot_git_dir.to_path_buf()
}

/// `isGitDirectory` (utils.ts:296-303): a `.git` directory is valid when it
/// contains a HEAD file (stat — follows symlinks).
fn is_git_directory(git_path: &Path) -> bool {
    std::fs::metadata(git_path.join("HEAD"))
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// First `gitdir: <path>` line of a `.git` file (`/^gitdir:\s*(.+)/m`, trimmed).
fn parse_gitdir_line(content: &str) -> Option<&str> {
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("gitdir:") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

/// `resolveGitBranch` (utils.ts:151-167): symbolic-ref first (fails on
/// detached HEAD / old layouts), then rev-parse --abbrev-ref (prints `HEAD`
/// verbatim when detached).
fn resolve_git_branch(checkout_root: &str) -> Option<String> {
    if let Some(stdout) = run_git(checkout_root, &["symbolic-ref", "--short", "HEAD"]) {
        let branch = stdout.trim();
        if !branch.is_empty() {
            return Some(branch.to_string());
        }
    }

    let stdout = run_git(checkout_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = stdout.trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

/// Spawn `git -C <dir> <args>` and return stdout on exit-0, else None
/// (mirrors execFileAsync rejecting on non-zero exit / spawn failure).
/// EVERY invocation sets GIT_OPTIONAL_LOCKS=0 (validator-A7) so the Task 18
/// polling loop can never keep rewriting .git/index.
fn run_git(dir: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Node `path.basename` final-component split — PLATFORM-DEPENDENT in Node:
/// posix splits on '/' ONLY (a backslash is an ordinary character); win32
/// splits on BOTH '/' and '\\'. Parameterized on the win32 flag so both
/// variants are unit-testable on any host; callers select with `cfg!(windows)`.
fn node_basename_split(source: &str, windows_semantics: bool) -> &str {
    if windows_semantics {
        source.rsplit(['/', '\\']).next().unwrap_or("")
    } else {
        source.rsplit('/').next().unwrap_or("")
    }
}

/// Node `os.homedir()` is PLATFORM-AWARE: POSIX reads `$HOME`; win32 reads
/// `%USERPROFILE%` (libuv `uv_os_homedir`). Try HOME first, then — Windows
/// builds only — fall back to USERPROFILE.
fn node_home_dir() -> Option<String> {
    let home = std::env::var("HOME").ok();
    #[cfg(windows)]
    let home = home.or_else(|| std::env::var("USERPROFILE").ok());
    home
}

/// Node `path.isAbsolute` is PLATFORM-AWARE: win32 also treats a bare leading
/// '/' or '\\' as absolute (e.g. `path.isAbsolute('/x') === true` on win32,
/// drive-relative), which Rust's `Path::is_absolute` on Windows rejects
/// (it requires a drive/UNC prefix). POSIX behavior is unchanged.
fn node_is_absolute(cwd: &str) -> bool {
    Path::new(cwd).is_absolute()
        || (cfg!(windows) && (cwd.starts_with('/') || cwd.starts_with('\\')))
}

/// Node `path.resolve` for an already-absolute base: purely lexical — collapses
/// `.` / `..` and trailing separators without touching the filesystem.
fn lexical_resolve(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            // `pop` at the root is a no-op — matches path.resolve('/..') === '/'.
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// `normalizePathForDisplay` (terminal-metadata-service.ts:43-46): strip
/// trailing `/` and `\`; a missing or empty input is None.
fn normalize_path_for_display(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    Some(value.trim_end_matches(['\\', '/']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }
    fn init_repo(dir: &std::path::Path) {
        git(dir, &["init", "-b", "main"]);
        std::fs::write(dir.join("f.txt"), "x").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "init"]);
    }
    #[test]
    fn plain_repo_roots_and_branch_and_dirty() {
        clear_git_meta_caches();
        let t = tempfile::tempdir().unwrap();
        init_repo(t.path());
        let p = t.path().to_str().unwrap();
        assert_eq!(
            resolve_git_repo_root(p).as_deref(),
            t.path().canonicalize().unwrap().to_str()
        );
        assert_eq!(resolve_git_checkout_root(p), resolve_git_repo_root(p));
        let bd = resolve_git_branch_and_dirty(p);
        assert_eq!(bd.branch.as_deref(), Some("main"));
        assert_eq!(bd.is_dirty, Some(false));
        std::fs::write(t.path().join("dirty.txt"), "y").unwrap();
        assert_eq!(resolve_git_branch_and_dirty(p).is_dirty, Some(true));
    }
    #[test]
    fn worktree_checkout_stays_but_repo_collapses_to_parent() {
        clear_git_meta_caches();
        let t = tempfile::tempdir().unwrap();
        init_repo(t.path());
        let wt = t.path().join("wt");
        git(
            t.path(),
            &["worktree", "add", "-b", "feat-x", wt.to_str().unwrap()],
        );
        let wts = wt.to_str().unwrap();
        assert_eq!(
            resolve_git_checkout_root(wts).as_deref(),
            wt.canonicalize().unwrap().to_str()
        );
        assert_eq!(
            resolve_git_repo_root(wts).as_deref(),
            t.path().canonicalize().unwrap().to_str()
        );
        assert_eq!(
            resolve_git_branch_and_dirty(wts).branch.as_deref(),
            Some("feat-x")
        );
    }
    #[test]
    fn non_repo_dir_returns_cwd_roots_and_empty_branch_dirty() {
        clear_git_meta_caches();
        let t = tempfile::tempdir().unwrap();
        let p = t.path().to_str().unwrap();
        assert_eq!(
            resolve_git_repo_root(p).as_deref(),
            t.path().canonicalize().unwrap().to_str()
        );
        assert_eq!(resolve_git_branch_and_dirty(p), BranchAndDirty::default());
    }
    #[test]
    fn relative_paths_are_refused() {
        assert_eq!(normalize_git_path_input("relative/dir"), None);
        assert_eq!(resolve_git_repo_root("relative/dir"), None);
    }
    /// Node parity (utils.ts:194 + :203-205): `fsp.readFile(gitPath)` sits
    /// INSIDE the per-level try/catch, so an unreadable `.git` FILE makes the
    /// walk CONTINUE to the parent — an enclosing repo root above must still
    /// be found.
    #[test]
    #[cfg(unix)]
    fn unreadable_git_file_keeps_walking_to_enclosing_repo_root() {
        use std::os::unix::fs::PermissionsExt;
        clear_git_meta_caches();
        let t = tempfile::tempdir().unwrap();
        init_repo(t.path());
        let sub = t.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let git_file = sub.join(".git");
        std::fs::write(&git_file, "gitdir: /nonexistent\n").unwrap();
        std::fs::set_permissions(&git_file, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&git_file).is_ok() {
            // Running with CAP_DAC_OVERRIDE (root/CI): permission bits don't
            // deny reads, so the unreadable fixture can't be constructed.
            eprintln!("skipping: .git file still readable despite mode 000");
            return;
        }
        assert_eq!(
            resolve_git_repo_root(sub.to_str().unwrap()).as_deref(),
            t.path().canonicalize().unwrap().to_str()
        );
    }
    /// Node parity (utils.ts:196-201): a READABLE `.git` file with no
    /// `gitdir:` line returns the dir holding it — the walk does NOT continue
    /// past it. Only read ERRORS continue (utils.ts:203-205).
    #[test]
    fn gitdir_less_git_file_is_the_root_itself_not_walked_past() {
        clear_git_meta_caches();
        let t = tempfile::tempdir().unwrap();
        init_repo(t.path());
        let sub = t.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join(".git"), "not a gitdir pointer\n").unwrap();
        assert_eq!(
            resolve_git_repo_root(sub.to_str().unwrap()).as_deref(),
            sub.canonicalize().unwrap().to_str()
        );
    }
    /// Node `path.basename` is platform-dependent: posix splits on '/' ONLY
    /// (backslash is an ordinary character); win32 splits on BOTH '/' and
    /// '\\'. Both variants are exercised here on any host via the flag.
    #[test]
    fn basename_split_matches_node_platform_semantics() {
        // posix semantics (windows_semantics = false)
        assert_eq!(node_basename_split("/a/b/sub", false), "sub");
        assert_eq!(node_basename_split("a/b\\c", false), "b\\c");
        assert_eq!(node_basename_split("C:\\repo\\sub", false), "C:\\repo\\sub");
        assert_eq!(node_basename_split("plain", false), "plain");
        // win32 semantics (windows_semantics = true)
        assert_eq!(node_basename_split("/a/b/sub", true), "sub");
        assert_eq!(node_basename_split("a/b\\c", true), "c");
        assert_eq!(node_basename_split("C:\\repo\\sub", true), "sub");
        assert_eq!(node_basename_split("plain", true), "plain");
    }
    #[test]
    fn display_subdir_prefers_checkout_root_basename() {
        assert_eq!(
            derive_display_subdir(Some("/a/b/sub"), Some("/a/b/")).as_deref(),
            Some("b")
        );
        assert_eq!(
            derive_display_subdir(Some("/a/b/sub"), None).as_deref(),
            Some("sub")
        );
        assert_eq!(derive_display_subdir(None, None), None);
    }
}
