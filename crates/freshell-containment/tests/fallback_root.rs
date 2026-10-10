//! The fallback containment (a process with no global containment: tests,
//! tools that never boot a server) keeps its unit records in a per-process
//! directory under the system temp directory, and that directory is removed
//! when the process exits (Task 12 review M7). The test runs itself as a
//! child process, so it observes a real exit.

use std::path::Path;

use freshell_containment::*;

const CHILD_ENV: &str = "FRESHELL_FALLBACK_ROOT_CHILD";
const TEST_NAME: &str = "the_fallback_state_root_is_removed_when_the_process_exits";

#[test]
fn the_fallback_state_root_is_removed_when_the_process_exits() {
    if std::env::var_os(CHILD_ENV).is_some() {
        // The child: a unit created through the fallback writes its record.
        let containment = global_or_fallback_containment();
        let unit = containment
            .create_unit(
                UnitId::mint(),
                UnitLabel {
                    provider: "test".into(),
                    ..Default::default()
                },
            )
            .expect("a unit of the fallback containment");
        let root = std::env::temp_dir().join(format!("freshell-units-{}", std::process::id()));
        let record = format!("{}.json", unit.id().as_str());
        let written = std::fs::read_dir(root.join("units"))
            .expect("the fallback's record directory")
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy() == record);
        assert!(written, "the unit's record is written under {root:?}");
        drop(unit);
        println!("FALLBACK_ROOT={}", root.display());
        return;
    }

    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST_NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, "1")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("run the child test process");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "child failed: {stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let root = stdout
        .lines()
        .find_map(|line| line.split_once("FALLBACK_ROOT=").map(|(_, root)| root.trim()))
        .unwrap_or_else(|| panic!("the child names its fallback root: {stdout}"));
    assert!(
        !Path::new(root).exists(),
        "the fallback state root {root} outlived its process"
    );
}
