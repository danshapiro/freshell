//! TERM-28: `$PATH`-only bare-command resolution unit tests
//! (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, grep
//! `TERM-28`).
//!
//! portable-pty 0.8.1's own `CommandBuilder::search_path` (unix) resolves a
//! bare relative command name against the spawn's cwd BEFORE `$PATH`, using a
//! bare `Path::exists()` check with no `is_file`/executable-bit validation --
//! so a same-named directory in the launch cwd shadows the real executable.
//! [`resolve_program_via_path`] sidesteps this by resolving bare names via
//! `$PATH` ONLY, with `is_file` + executable-bit validation per candidate,
//! never consulting any notion of "current directory" at all.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use freshell_platform::path::{resolve_program_via_path, ProgramNotFound};

/// Write an executable regular file at `dir/name` (unix: `chmod 0o755`).
fn write_executable(dir: &Path, name: &str) {
    let file = dir.join(name);
    fs::write(&file, b"#!/bin/sh\necho real-cli-ran\n").expect("write executable fixture");
    let mut perms = fs::metadata(&file).expect("metadata").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&file, perms).expect("chmod");
}

/// Write a NON-executable regular file at `dir/name` (unix: `chmod 0o644`).
fn write_non_executable(dir: &Path, name: &str) {
    let file = dir.join(name);
    fs::write(&file, b"not executable\n").expect("write non-executable fixture");
    let mut perms = fs::metadata(&file).expect("metadata").permissions();
    perms.set_mode(0o644);
    fs::set_permissions(&file, perms).expect("chmod");
}

/// A tiny RAII guard that restores the process cwd on drop, even on panic --
/// used ONLY by the one test in this file that mutates it (no other test
/// here reads or depends on cwd, so this is safe under the default parallel
/// test harness).
struct CwdGuard {
    original: std::path::PathBuf,
}

impl CwdGuard {
    fn enter(dir: &Path) -> Self {
        let original = std::env::current_dir().expect("current_dir");
        std::env::set_current_dir(dir).expect("set_current_dir");
        CwdGuard { original }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.original);
    }
}

/// **The core TERM-28 regression.** A directory named exactly like the CLI
/// exists in the launch cwd (e.g. `~/code/amplifier`, a repo checkout) AND a
/// real executable of the same bare name exists on `$PATH`. Resolution must
/// return the `$PATH` executable -- the cwd-resident directory must be
/// completely invisible to the resolver, because it never consults cwd at
/// all (unlike portable-pty's own buggy `search_path`, which checks
/// `cwd.join(exe).exists()` FIRST and would match the directory).
#[test]
fn bare_name_shadowed_by_cwd_directory_resolves_to_path_binary() {
    let cwd_dir = tempfile::tempdir().expect("tempdir cwd");
    // The shadowing entity: a DIRECTORY named "amplifier", sitting right in
    // what will be the process's cwd -- exactly the reported bug scenario
    // (`~/code/amplifier` repo checkout shadowing the `amplifier` CLI).
    fs::create_dir(cwd_dir.path().join("amplifier")).expect("mkdir shadow");

    let path_dir = tempfile::tempdir().expect("tempdir PATH entry");
    write_executable(path_dir.path(), "amplifier");

    // Actually chdir into the shadow directory so this test exercises the
    // real-world condition end-to-end, not just "the function has no cwd
    // parameter so it can't be affected" as a structural argument.
    let _guard = CwdGuard::enter(cwd_dir.path());

    let path_var = path_dir.path().to_string_lossy().into_owned();
    let resolved =
        resolve_program_via_path("amplifier", Some(&path_var)).expect("resolves via $PATH");

    assert_eq!(
        resolved,
        path_dir.path().join("amplifier").to_string_lossy()
    );
}

/// A bare name that exists nowhere on `$PATH` must fail with a structured,
/// typed error -- never a panic, never silently falling back to the
/// unresolved bare name (which would hand portable-pty the exact input that
/// triggers its cwd-shadow abort bug).
#[test]
fn missing_command_returns_structured_error_never_panics() {
    let path_dir = tempfile::tempdir().expect("tempdir PATH entry");
    // path_dir intentionally contains nothing named "totally-missing-cli".
    let path_var = path_dir.path().to_string_lossy().into_owned();

    let result = resolve_program_via_path("totally-missing-cli", Some(&path_var));
    assert_eq!(result, Err(ProgramNotFound));

    // Also: an entirely unset $PATH must fail cleanly, not panic.
    let result_no_path = resolve_program_via_path("totally-missing-cli", None);
    assert_eq!(result_no_path, Err(ProgramNotFound));
}

/// Any input containing a path separator (absolute, or an explicit relative
/// path like `./foo`) is not a bare name -- returned unchanged, no `$PATH`
/// search, matching portable-pty's own (unaffected) absolute-path branch.
#[test]
fn absolute_path_input_unchanged() {
    // Note: no PATH is provided and the path need not exist -- passthrough
    // performs no validation of its own (portable-pty validates it).
    assert_eq!(
        resolve_program_via_path("/custom/amplifier", None),
        Ok("/custom/amplifier".to_string())
    );
    assert_eq!(
        resolve_program_via_path("./local-script", None),
        Ok("./local-script".to_string())
    );
}

/// A `$PATH` entry containing a non-executable regular file (or a directory)
/// matching the bare name must be SKIPPED, and the search must continue to
/// the next `$PATH` entry -- `execvp` semantics, not "first match wins
/// regardless of validity" (the exact defect in portable-pty's own cwd
/// branch, which accepts ANY `exists()` match with no further validation).
#[test]
fn non_executable_file_on_path_skipped_continues_search() {
    let first_dir = tempfile::tempdir().expect("tempdir PATH entry 1");
    write_non_executable(first_dir.path(), "mycli");
    // Also plant a directory match in the SAME dir under a second name to
    // prove directories are skipped too, not just chmod-644 files.
    fs::create_dir(first_dir.path().join("dircli")).expect("mkdir");

    let second_dir = tempfile::tempdir().expect("tempdir PATH entry 2");
    write_executable(second_dir.path(), "mycli");
    write_executable(second_dir.path(), "dircli");

    let path_var = std::env::join_paths([first_dir.path(), second_dir.path()])
        .expect("join_paths")
        .to_string_lossy()
        .into_owned();

    let resolved = resolve_program_via_path("mycli", Some(&path_var)).expect("skips to dir 2");
    assert_eq!(resolved, second_dir.path().join("mycli").to_string_lossy());

    let resolved_dircli =
        resolve_program_via_path("dircli", Some(&path_var)).expect("skips directory match");
    assert_eq!(
        resolved_dircli,
        second_dir.path().join("dircli").to_string_lossy()
    );
}
