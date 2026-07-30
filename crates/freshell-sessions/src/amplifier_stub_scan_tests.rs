/// Tests for `session_on_disk` scanning logic.
use super::*;

use std::sync::atomic::{AtomicU64, Ordering as TestOrdering};

static SCAN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn scan_temp_home(label: &str) -> std::path::PathBuf {
    let n = SCAN_COUNTER.fetch_add(1, TestOrdering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "freshell-amplifier-scan-{label}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Permission tests are meaningless as root (root ignores mode bits) —
/// e.g. sandboxed/container suites. Skip (return early) when euid == 0.
fn running_as_root() -> bool {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

#[test]
fn session_on_disk_present_under_cwd_slug() {
    let home = scan_temp_home("present");
    let sess = home.join("projects/-home-dan-proj/sessions/sid-1");
    std::fs::create_dir_all(&sess).unwrap();
    assert!(matches!(
        session_on_disk(&home, "sid-1"),
        AmplifierSessionAnswer::Present
    ));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn session_on_disk_present_under_divergent_slug() {
    // The tab may have moved cwd; the session lives under ANOTHER project
    // slug. Scanning all project dirs must still find it (plan decision:
    // search all projects, documented in Global Constraints).
    let home = scan_temp_home("divergent");
    std::fs::create_dir_all(home.join("projects/-some-other-project/sessions/sid-2")).unwrap();
    std::fs::create_dir_all(home.join("projects/-home-dan-proj")).unwrap();
    assert!(matches!(
        session_on_disk(&home, "sid-2"),
        AmplifierSessionAnswer::Present
    ));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn session_on_disk_absent_when_store_readable() {
    let home = scan_temp_home("absent");
    std::fs::create_dir_all(home.join("projects/-home-dan-proj/sessions/other-sid")).unwrap();
    assert!(matches!(
        session_on_disk(&home, "sid-3"),
        AmplifierSessionAnswer::Absent
    ));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn session_on_disk_absent_when_projects_dir_missing() {
    // Store root exists but amplifier has never created projects/:
    // readable-and-empty => definitively absent.
    let home = scan_temp_home("noprojects");
    assert!(matches!(
        session_on_disk(&home, "sid-4"),
        AmplifierSessionAnswer::Absent
    ));
    let _ = std::fs::remove_dir_all(&home);
}

#[cfg(unix)]
#[test]
fn session_on_disk_unreadable_projects_dir_fails_open() {
    use std::os::unix::fs::PermissionsExt;
    if running_as_root() {
        return; // root ignores mode bits — test is meaningless
    }
    let home = scan_temp_home("unreadable");
    let projects = home.join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
    let answer = session_on_disk(&home, "sid-5");
    // Restore perms before asserting so cleanup works even on failure.
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(answer, AmplifierSessionAnswer::Unreadable));
    let _ = std::fs::remove_dir_all(&home);
}

#[cfg(unix)]
#[test]
fn session_on_disk_unreadable_project_subdir_fails_open() {
    // V3 case E2a: a chmod-000 PROJECT dir with the session inside must
    // answer Unreadable, never Absent (`.is_dir()` returns false on
    // EACCES — the errors-seen accumulator catches the metadata error).
    use std::os::unix::fs::PermissionsExt;
    if running_as_root() {
        return;
    }
    let home = scan_temp_home("locked-project");
    let locked = home.join("projects/-locked-proj");
    std::fs::create_dir_all(locked.join("sessions/sid-7")).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let answer = session_on_disk(&home, "sid-7");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(answer, AmplifierSessionAnswer::Unreadable));
    let _ = std::fs::remove_dir_all(&home);
}

#[cfg(unix)]
#[test]
fn session_on_disk_listable_not_traversable_projects_fails_open() {
    // V3 case E2b: projects/ mode 444 — read_dir succeeds (needs r) but
    // stat into children needs x, so every per-entry metadata call errors.
    // Any-error-and-no-hit => Unreadable.
    use std::os::unix::fs::PermissionsExt;
    if running_as_root() {
        return;
    }
    let home = scan_temp_home("no-traverse");
    let projects = home.join("projects");
    std::fs::create_dir_all(projects.join("-p/sessions/sid-8")).unwrap();
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o444)).unwrap();
    let answer = session_on_disk(&home, "sid-8");
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(answer, AmplifierSessionAnswer::Unreadable));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn session_on_disk_matches_a_file_only_as_absent() {
    // A stray FILE named like the session id is not a session dir.
    let home = scan_temp_home("file-not-dir");
    let sessions = home.join("projects/-p/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(sessions.join("sid-6"), b"junk").unwrap();
    assert!(matches!(
        session_on_disk(&home, "sid-6"),
        AmplifierSessionAnswer::Absent
    ));
    let _ = std::fs::remove_dir_all(&home);
}
