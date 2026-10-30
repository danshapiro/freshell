//! Test-only Windows owner for a fixture's complete process tree.
//!
//! Usage: fixture-job-host REQUEST.json STATUS.json CONTROL.json
//! The target inherits stdin/stdout/stderr, while ownership and control use
//! private JSON files. A natural root exit does not stop its descendants.

use serde::Serialize;
use std::{ffi::OsString, io, path::Path};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    root_exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    settled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
}

fn publish_status(path: &Path, status: &Status) -> io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temporary, serde_json::to_vec(status)?)?;
    std::fs::rename(&temporary, path)
}

fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
    let mut status = Status::default();
    let result = if args.len() == 4 {
        run(&args, &mut status)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: fixture-job-host REQUEST.json STATUS.json CONTROL.json",
        ))
    };
    if let Err(error) = result {
        // Before any target was spawned there cannot be a fixture writer.
        // Once a PID existed, an error never counts as confirmed cleanup.
        status.settled = cfg!(windows) && status.pid.is_none();
        status.error = Some(error.to_string());
        status.error_code = Some(match error.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::Unsupported => "ENOTSUP",
            _ => "EIO",
        });
        if let Some(path) = args.get(2) {
            let _ = publish_status(Path::new(path), &status);
        }
        use std::io::Write;
        // Standard handles are closed after the target starts; before that,
        // stderr is available. The status file remains the failure receipt.
        let _ = writeln!(
            std::io::stderr(),
            "{}",
            serde_json::json!({
                "severity": "error", "component": "fixture-job-host",
                "event": "fixture.job_host.failed", "error": error.to_string(),
            })
        );
        std::process::exit(2);
    }
}

#[cfg(not(windows))]
fn run(_: &[OsString], _: &mut Status) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "fixture-job-host requires native Windows Job Objects",
    ))
}

#[cfg(windows)]
fn run(args: &[OsString], status: &mut Status) -> io::Result<()> {
    windows::run(
        Path::new(&args[1]),
        Path::new(&args[2]),
        Path::new(&args[3]),
        status,
    )
}

#[cfg(windows)]
mod windows {
    use super::{publish_status, Status};
    use freshell_platform::process_job::{
        resume_suspended_process, JobMembers, KillOnCloseJob, ProcessExitWatch, CREATE_SUSPENDED,
    };
    use serde::Deserialize;
    use std::{
        collections::{BTreeMap, HashSet},
        io,
        os::windows::process::CommandExt,
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    const POLL: Duration = Duration::from_millis(10);
    const SETTLE_TIMEOUT: Duration = Duration::from_secs(10);

    fn controller_exited(owner: Option<&ProcessExitWatch>) -> io::Result<bool> {
        owner.map_or(Ok(false), |watch| watch.wait(Duration::ZERO))
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Request {
        pub(super) command: String,
        pub(super) args: Vec<String>,
        pub(super) cwd: Option<PathBuf>,
        pub(super) env: Option<BTreeMap<String, String>>,
        pub(super) owner_pid: Option<u32>,
    }

    #[derive(Deserialize)]
    #[serde(tag = "action")]
    enum Control {
        #[serde(rename = "kill-root")]
        KillRoot { signal: Option<String> },
        #[serde(rename = "stop")]
        Stop,
    }

    pub(super) struct OwnedJob {
        job: KillOnCloseJob,
        members: JobMembers,
        root: Child,
    }

    impl OwnedJob {
        pub(super) fn spawn(request: Request, status: &mut Status) -> io::Result<Self> {
            let job = KillOnCloseJob::new()?;
            let mut command = Command::new(request.command);
            command
                .args(request.args)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .creation_flags(CREATE_SUSPENDED);
            if let Some(cwd) = request.cwd {
                command.current_dir(cwd);
            }
            if let Some(env) = request.env {
                command.env_clear().envs(env);
            }
            let mut root = command.spawn()?;
            status.pid = Some(root.id());
            if let Err(error) = job.assign_process(root.id()) {
                // Assignment failed: the suspended process must never run.
                let _ = root.kill();
                let _ = root.wait();
                return Err(error);
            }
            let mut members = JobMembers::default();
            // Subscribe before resume: even a descendant that starts exiting
            // before a later poll is reported by the job's completion port.
            members.record(&job)?;
            Ok(Self { job, members, root })
        }

        pub(super) fn resume(&self) -> io::Result<()> {
            resume_suspended_process(self.root.id())
        }

        pub(super) fn observe_root(&mut self, status: &mut Status) -> io::Result<bool> {
            if status.root_exited {
                return Ok(false);
            }
            if let Some(exit) = self.root.try_wait()? {
                status.root_exited = true;
                status.exit_code = exit.code();
                return Ok(true);
            }
            Ok(false)
        }

        pub(super) fn kill_root(&mut self) -> io::Result<()> {
            if self.root.try_wait()?.is_none() {
                self.root.kill()?;
            }
            Ok(())
        }

        pub(super) fn stop(&mut self, status: &mut Status) -> io::Result<()> {
            self.members.record(&self.job)?;
            self.job.terminate()?;
            let deadline = Instant::now() + SETTLE_TIMEOUT;
            loop {
                self.members.record(&self.job)?;
                self.observe_root(status)?;
                // ActiveProcesses becomes zero before all process handles
                // signal. Both observations are required before deletion.
                if self.job.active_processes()? == 0 && !self.members.any_running()? {
                    if !status.root_exited {
                        return Err(io::Error::other(
                            "job members exited without a root exit observation",
                        ));
                    }
                    status.settled = true;
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "owned fixture job still has unconfirmed process exits",
                    ));
                }
                std::thread::sleep(POLL);
            }
        }
    }

    pub(super) fn run(
        request_path: &Path,
        status_path: &Path,
        control_path: &Path,
        status: &mut Status,
    ) -> io::Result<()> {
        let request: Request = serde_json::from_slice(&std::fs::read(request_path)?)?;
        // Keep the controller's actual handle: its death abandons the fixture
        // even though the helper has closed its own standard-pipe copies.
        let owner = request.owner_pid.map(ProcessExitWatch::open).transpose()?;
        if controller_exited(owner.as_ref())? {
            return Err(io::Error::other("fixture controller has already exited"));
        }
        let mut owned = OwnedJob::spawn(request, status)?;
        publish_status(status_path, status)?;
        close_inherited_standard_handles()?;
        owned.resume()?;
        let mut last_control = Vec::new();
        loop {
            if controller_exited(owner.as_ref())? {
                owned.stop(status)?;
                publish_status(status_path, status)?;
                return Ok(());
            }
            // Tracking continues after the root exits. No fixture teardown
            // occurs until the controller explicitly sends `stop`.
            owned.members.record(&owned.job)?;
            if owned.observe_root(status)? {
                publish_status(status_path, status)?;
            }
            match std::fs::read(control_path) {
                Ok(bytes) if bytes != last_control => {
                    let control: Control = serde_json::from_slice(&bytes)?;
                    last_control = bytes;
                    match control {
                        Control::KillRoot { signal } => {
                            // Node's supported Windows termination signals
                            // all forcibly terminate the one target process.
                            if let Some(signal) = signal {
                                if !matches!(
                                    signal.as_str(),
                                    "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGQUIT"
                                ) {
                                    return Err(io::Error::new(
                                        io::ErrorKind::InvalidInput,
                                        "unsupported fixture root termination signal",
                                    ));
                                }
                            }
                            owned.kill_root()?;
                        }
                        Control::Stop => {
                            owned.stop(status)?;
                            publish_status(status_path, status)?;
                            return Ok(());
                        }
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            std::thread::sleep(POLL);
        }
    }

    fn close_inherited_standard_handles() -> io::Result<()> {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

        // These two console APIs are used only by this test executable; keep
        // production crate features unchanged.
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetStdHandle(kind: u32) -> HANDLE;
            fn SetStdHandle(kind: u32, handle: HANDLE) -> i32;
        }

        let mut handles = HashSet::new();
        for kind in [-10_i32, -11, -12] {
            let handle = unsafe { GetStdHandle(kind as u32) };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            if handle.is_null() {
                continue;
            }
            if unsafe { SetStdHandle(kind as u32, std::ptr::null_mut()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            handles.insert(handle as usize);
        }
        // Command::spawn already gave the target its own copies. Closing the
        // helper's copies lets its target's real pipe EOF reach the caller.
        for handle in handles {
            if unsafe { CloseHandle(handle as HANDLE) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{windows::*, Status};
    use freshell_platform::process_job::ProcessExitWatch;
    use std::{
        collections::BTreeMap,
        path::Path,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    const MODE: &str = "FRESHELL_FIXTURE_JOB_TEST_MODE";
    const WRITER: &str = "FRESHELL_FIXTURE_JOB_TEST_WRITER";

    fn child(mode: &str, marker: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "tests::fixture_child", "--nocapture"])
            .env(MODE, mode)
            .env(WRITER, marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[test]
    fn fixture_child() {
        let Ok(mode) = std::env::var(MODE) else {
            return;
        };
        let marker = std::path::PathBuf::from(std::env::var_os(WRITER).unwrap());
        match mode.as_str() {
            "writer" => {
                std::fs::write(&marker, std::process::id().to_string()).unwrap();
                loop {
                    std::fs::write(marker.with_extension("heartbeat"), b"still writing").unwrap();
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            "middle" => {
                // Deliberately orphan a writer before its ancestor stops.
                #[allow(clippy::zombie_processes)]
                let _writer = child("writer", &marker).spawn().unwrap();
            }
            "root-exits" | "root-waits" => {
                child("middle", &marker).spawn().unwrap().wait().unwrap();
                if mode == "root-waits" {
                    loop {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            }
            _ => panic!("unknown fixture mode"),
        }
    }

    fn fixture(mode: &str, marker: &Path) -> OwnedJob {
        let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
        env.insert(MODE.into(), mode.into());
        env.insert(WRITER.into(), marker.to_string_lossy().into_owned());
        let owned = OwnedJob::spawn(
            Request {
                command: std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                args: vec![
                    "--exact".into(),
                    "tests::fixture_child".into(),
                    "--nocapture".into(),
                ],
                cwd: None,
                env: Some(env),
                owner_pid: None,
            },
            &mut Status::default(),
        )
        .unwrap();
        owned.resume().unwrap();
        owned
    }

    fn wait_for_writer(marker: &Path) -> ProcessExitWatch {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(pid) = std::fs::read_to_string(marker) {
                if let Ok(pid) = pid.parse() {
                    return ProcessExitWatch::open(pid).expect("hold the actual writer's handle");
                }
            }
            assert!(
                Instant::now() < deadline,
                "the grandchild writer never started"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_for_root(owned: &mut OwnedJob, status: &mut Status) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !status.root_exited {
            owned.observe_root(status).unwrap();
            assert!(Instant::now() < deadline, "the root never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn exited_root_keeps_its_grandchild_until_explicit_confirmed_stop() {
        let root = tempfile::tempdir().unwrap();
        let mut owned = fixture("root-exits", &root.path().join("writer.pid"));
        let writer = wait_for_writer(&root.path().join("writer.pid"));
        let mut status = Status::default();
        wait_for_root(&mut owned, &mut status);
        assert!(!status.settled);
        assert!(!writer.wait(Duration::ZERO).unwrap());
        owned.stop(&mut status).unwrap();
        assert!(status.settled);
        assert!(writer.wait(Duration::ZERO).unwrap());
    }

    #[test]
    fn killing_only_the_root_preserves_its_grandchild_until_stop() {
        let root = tempfile::tempdir().unwrap();
        let mut owned = fixture("root-waits", &root.path().join("writer.pid"));
        let writer = wait_for_writer(&root.path().join("writer.pid"));
        owned.kill_root().unwrap();
        let mut status = Status::default();
        wait_for_root(&mut owned, &mut status);
        assert!(!status.settled);
        assert!(!writer.wait(Duration::ZERO).unwrap());
        owned.stop(&mut status).unwrap();
        assert!(status.settled);
        assert!(writer.wait(Duration::ZERO).unwrap());
    }

    #[test]
    fn a_missing_executable_never_records_a_target_pid() {
        let root = tempfile::tempdir().unwrap();
        let mut status = Status::default();
        let result = OwnedJob::spawn(
            Request {
                command: root
                    .path()
                    .join("missing.exe")
                    .to_string_lossy()
                    .into_owned(),
                args: vec![],
                cwd: None,
                env: None,
                owner_pid: None,
            },
            &mut status,
        );
        assert_eq!(result.err().unwrap().kind(), std::io::ErrorKind::NotFound);
        assert!(status.pid.is_none());
    }
}
