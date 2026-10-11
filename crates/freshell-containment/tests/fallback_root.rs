//! The fallback containment (a process with no global containment: tests,
//! tools that never boot a server) keeps its unit records in a per-process
//! directory under the system temp directory, and that directory is removed
//! when the process exits (Task 12 review M7), after the units still
//! recorded there are stopped. The tests run themselves as a child process,
//! so they observe a real exit.

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
        .find_map(|line| {
            line.split_once("FALLBACK_ROOT=")
                .map(|(_, root)| root.trim())
        })
        .unwrap_or_else(|| panic!("the child names its fallback root: {stdout}"));
    assert!(
        !Path::new(root).exists(),
        "the fallback state root {root} outlived its process"
    );
}

#[cfg(unix)]
const UNITS_CHILD_ENV: &str = "FRESHELL_FALLBACK_UNITS_CHILD";
#[cfg(unix)]
const UNITS_TEST_NAME: &str = "a_unit_still_recorded_when_the_process_exits_is_stopped_first";

/// A test that ends before one of its panes' units reaches Gone (a failed
/// assertion, an `expect` timeout) exits with that unit still recorded under
/// the fallback root. Nothing can ever reach it again (no server boots on
/// that root), so its members die with the process instead of running on:
/// a member found by its tag (the Codex sidecar's shape: its own process
/// group, never pinned) and one found by its recorded root. The child test
/// process ([`exit_with_a_running_unit`]) creates the unit, starts both,
/// names them, and exits without stopping the unit.
#[cfg(unix)]
#[test]
fn a_unit_still_recorded_when_the_process_exits_is_stopped_first() {
    use std::process::{Command, Stdio};
    use std::time::Duration;

    if std::env::var_os(UNITS_CHILD_ENV).is_some() {
        exit_with_a_running_unit();
        return;
    }

    let out = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            UNITS_TEST_NAME,
            "--nocapture",
            "--test-threads=1",
        ])
        .env(UNITS_CHILD_ENV, "1")
        .stdin(Stdio::null())
        .output()
        .expect("run the child test process");
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Each member as (what, pid, start time); libtest may print its own
    // text ahead of a line on the same line.
    let named: Vec<(String, u32, u64)> = stdout
        .lines()
        .filter_map(|line| line.split_once("MEMBER=").map(|(_, rest)| rest))
        .map(|rest| {
            let mut fields = rest.split_whitespace();
            let mut next = || fields.next().expect("what, pid and start time");
            (
                next().to_string(),
                next().parse().unwrap(),
                next().parse().unwrap(),
            )
        })
        .collect();
    // Pinned by pid AND start time: a member that already exited (and whose
    // pid may name another process by now) is gone.
    let mut alive = Members(Vec::new());
    for (what, pid, start) in &named {
        match ProcWatch::open_expecting(*pid, *start) {
            Ok(watch) => alive.0.push((what.clone(), watch)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => panic!("cannot pin the {what} member {pid}: {err}"),
        }
    }
    assert!(
        out.status.success() && named.len() == 2,
        "child failed: {stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for (what, watch) in &alive.0 {
        let exited = rt.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), watch.exited()).await
        });
        assert!(
            matches!(exited, Ok(Ok(()))),
            "the {what} member {} outlived the process whose unit it was in: {exited:?}",
            watch.pid()
        );
    }
}

/// The child test process: creates a unit through the fallback, starts its
/// two members (each in its own process group, as the Codex start spawns a
/// sidecar), names them, and returns into an ordinary exit with the unit
/// still recorded: never stopped, never Gone. Its members are deliberately
/// never waited for.
#[cfg(unix)]
#[allow(clippy::zombie_processes)]
fn exit_with_a_running_unit() {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let unit = global_or_fallback_containment()
        .create_unit(
            UnitId::mint(),
            UnitLabel {
                provider: "codex".into(),
                ..Default::default()
            },
        )
        .expect("a unit of the fallback containment");
    let sleeper = |env: &[(String, String)]| {
        Command::new("sleep")
            .arg("600")
            .envs(env.iter().map(|(k, v)| (k, v)))
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start a member")
    };
    let placement = unit.placement(MemberRole::Agent).unwrap();
    assert!(placement.wrapper.is_none(), "the fallback has no shim");
    let tagged = sleeper(&placement.env);
    let rooted = sleeper(&[]);
    unit.add_root(ProcWatch::open(rooted.id()).unwrap());
    for (what, child) in [("tagged", &tagged), ("rooted", &rooted)] {
        // Our own unreaped child: its pid names it.
        let start = ProcWatch::open(child.id()).unwrap().identity().start;
        println!("MEMBER={what} {} {start}", child.id());
    }
}

/// The child's members still running when this test pinned them: whatever
/// is still running when the test ends (the red shape) is killed through
/// its pin, which can only reach that incarnation.
#[cfg(unix)]
struct Members(Vec<(String, ProcWatch)>);

#[cfg(unix)]
impl Drop for Members {
    fn drop(&mut self) {
        for (_, watch) in &self.0 {
            let _ = watch.signal(Sig::Kill);
        }
    }
}
