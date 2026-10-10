//! Process-local homes for tests that exercise the ordinary OpenCode TUI.

use std::io::Write;
use std::process::{Command, Stdio};

const HOME_CHILD: &str = "FRESHELL_OPENCODE_HOME_TEST_CHILD";

fn record(value: serde_json::Value) -> std::io::Result<()> {
    eprintln!("{value}");
    if let Some(path) = std::env::var_os("FRESHELL_TEST_RESOURCE_RECEIPT") {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        file.write_all(format!("{value}\n").as_bytes())?;
    }
    Ok(())
}

/// Re-execute the exact existing contract with a writable synthetic home.
/// The parent keeps its actual home and holds the TempDir until the child joins.
pub(crate) fn run_with_opencode_home(test: &str) -> bool {
    if let Ok(child_test) = std::env::var(HOME_CHILD) {
        assert_eq!(child_test, test, "isolated child ran the wrong contract");
        return false;
    }
    let home = tempfile::tempdir().expect("create isolated OpenCode test home");
    let original_home = std::env::var_os("HOME");
    let original_profile = std::env::var_os("USERPROFILE");
    let child = Command::new(std::env::current_exe().expect("resolve freshagent test binary"))
        .args(["--exact", test, "--nocapture"])
        .env(HOME_CHILD, test)
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn exact isolated OpenCode contract");
    let pid = child.id();
    // A diagnostic write failure must still join the already spawned child.
    let started = record(
        serde_json::json!({"severity":"info", "event":"opencode_home_test_started", "test":test, "pid":pid, "home":home.path()}),
    );
    let output = child
        .wait_with_output()
        .expect("join isolated OpenCode contract");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let exact_completed = stdout
        .lines()
        .any(|line| line == format!("test {test} ... ok"))
        && stdout.lines().any(|line| line == "running 1 test")
        && stdout.contains("test result: ok. 1 passed; 0 failed; 0 ignored;");
    let joined = record(
        serde_json::json!({"severity":if output.status.success() && exact_completed {"info"} else {"error"}, "event":"opencode_home_test_joined", "test":test, "pid":pid, "code":output.status.code(), "exactCompleted":exact_completed}),
    );
    let plugin_installed =
        freshell_platform::opencode_plugin::rebind_plugin_path(home.path()).is_file();
    let selector_installed =
        freshell_platform::opencode_plugin::tui_config_path(home.path()).is_file();
    let home_path = home.path().to_owned();
    let removed = home.close();
    let settled = record(
        serde_json::json!({"severity":if removed.is_ok() {"info"} else {"error"}, "event":"opencode_home_test_settled", "test":test, "pid":pid, "home":home_path}),
    );
    // Propagate every failure after the child's join and owned-home cleanup.
    started.expect("record started test resource");
    joined.expect("record joined test resource");
    removed.expect("remove joined child's owned home");
    settled.expect("record settled test resource");
    assert!(!home_path.exists(), "joined child's home must be removed");
    // Prefix child output on failure so its harness lines cannot masquerade as
    // completions of the outer 1296-test workload.
    assert!(
        output.status.success() && exact_completed,
        "isolated contract failed: {test}\n{}",
        stdout
            .lines()
            .map(|line| format!("[home-child stdout] {line}"))
            .chain(
                String::from_utf8_lossy(&output.stderr)
                    .lines()
                    .map(|line| format!("[home-child stderr] {line}"))
            )
            .collect::<Vec<_>>()
            .join("\n"),
    );
    assert!(
        plugin_installed,
        "the contract must install the real TUI plugin"
    );
    assert!(
        selector_installed,
        "the contract must materialize its real TUI selector"
    );
    assert_eq!(std::env::var_os("HOME"), original_home);
    assert_eq!(std::env::var_os("USERPROFILE"), original_profile);
    true
}
