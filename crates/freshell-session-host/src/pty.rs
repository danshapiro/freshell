use crate::{
    command_journal::{BeginDisposition, CommandJournal},
    output_journal::OutputJournal,
};
use freshell_platform::SpawnSpec;
use freshell_protocol::ServerMessage;
use freshell_runtime_protocol::{
    CommandState, IncarnationId, RequestId, RuntimeError, RuntimeErrorCode, RuntimeOutputBatch,
    TerminalLaunchSpec,
};
use freshell_sessions::parse::opencode::{OpencodeProvider, OpencodeSessionRow};
use freshell_terminal::PtyTerminal;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub struct HostedPty {
    pty: PtyTerminal,
    output: Arc<Mutex<OutputJournal>>,
    commands: CommandJournal,
    exited: Arc<AtomicBool>,
    exit_code: Arc<AtomicI64>,
    terminal_id: String,
    stream_epoch: String,
    native_session_id: Arc<Mutex<Option<String>>>,
}

impl HostedPty {
    pub fn spawn(
        state_dir: &Path,
        incarnation_id: IncarnationId,
        launch: &TerminalLaunchSpec,
    ) -> Result<Self, String> {
        launch.validate().map_err(|e| e.message)?;
        let launch_floor_ms = epoch_ms().saturating_sub(500);
        let stream_epoch = format!(
            "{}-{}",
            launch.stream_id,
            freshell_runtime_protocol::HostBootId::new()
        );
        let output = Arc::new(Mutex::new(OutputJournal::new(
            state_dir,
            incarnation_id,
            launch.terminal_id.clone(),
            stream_epoch.clone(),
        )?));
        let sink_output = Arc::clone(&output);
        let sink = Box::new(move |message: ServerMessage| {
            if let ServerMessage::TerminalOutput(frame) = message {
                if let Ok(mut journal) = sink_output.lock() {
                    let _ = journal.append(&frame.data);
                }
            }
        });
        let exited = Arc::new(AtomicBool::new(false));
        let exit_code = Arc::new(AtomicI64::new(0));
        let exit_flag = Arc::clone(&exited);
        let exit_value = Arc::clone(&exit_code);
        let on_exit = Box::new(move |code: i64| {
            exit_value.store(code, Ordering::SeqCst);
            exit_flag.store(true, Ordering::SeqCst);
        });
        let mut provider_args = vec![
            "--reuid".to_string(),
            launch.run_as_uid.to_string(),
            "--regid".to_string(),
            launch.run_as_gid.to_string(),
            "--clear-groups".to_string(),
            "--no-new-privs".to_string(),
            "--".to_string(),
            launch.program.clone(),
        ];
        provider_args.extend(launch.args.clone());
        let spec = SpawnSpec {
            program: "/usr/bin/setpriv".to_string(),
            args: provider_args,
            env_overrides: BTreeMap::new(),
            cwd: Some(launch.cwd.clone()),
            cols: launch.cols,
            rows: launch.rows,
        };
        let mut provider_env = launch.env.clone();
        // Rootless Docker maps the host user's bind-mounted workspace to
        // container uid 0, while the provider intentionally runs as uid
        // 65534. Tell Git that this one already-approved workspace is safe
        // without modifying host or provider-global git configuration.
        provider_env.insert("GIT_CONFIG_COUNT".into(), "1".into());
        provider_env.insert("GIT_CONFIG_KEY_0".into(), "safe.directory".into());
        provider_env.insert("GIT_CONFIG_VALUE_0".into(), launch.workspace_path.clone());
        let pty = PtyTerminal::spawn_with_sink(
            &spec,
            &provider_env,
            &launch.terminal_id,
            &launch.stream_id,
            None,
            Some(sink),
            Some(on_exit),
        )
        .map_err(|e| e.to_string())?;
        let commands = CommandJournal::open(state_dir)?;
        let native_session_id = Arc::new(Mutex::new(launch.resume_session_id.clone()));
        if launch.mode == "opencode" && launch.resume_session_id.is_none() {
            spawn_opencode_identity_watcher(
                launch,
                launch_floor_ms,
                Arc::clone(&native_session_id),
                Arc::clone(&exited),
            );
        }
        Ok(Self {
            pty,
            output,
            commands,
            exited,
            exit_code,
            terminal_id: launch.terminal_id.clone(),
            stream_epoch,
            native_session_id,
        })
    }

    pub fn write_input(
        &mut self,
        request_id: &RequestId,
        data: &str,
    ) -> Result<CommandState, RuntimeError> {
        match self.commands.begin(request_id, data.as_bytes())? {
            BeginDisposition::Completed => return Ok(CommandState::Completed),
            BeginDisposition::Ambiguous => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::CommandAmbiguous,
                    "input may already have reached the PTY; refusing automatic redispatch",
                ))
            }
            BeginDisposition::Dispatch => {}
        }
        self.commands.mark_dispatching(request_id)?;
        self.pty
            .write_input(data.as_bytes())
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::HostUnreachable, e.to_string()))?;
        self.commands.mark_completed(request_id)?;
        Ok(CommandState::Completed)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), RuntimeError> {
        if cols == 0 || rows == 0 {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "terminal dimensions must be positive",
            ));
        }
        self.pty.resize(cols, rows);
        Ok(())
    }

    pub fn read_output(
        &self,
        incarnation_id: IncarnationId,
        after_seq: u64,
        max_bytes: u64,
    ) -> Result<RuntimeOutputBatch, RuntimeError> {
        let mut batch = self
            .output
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "output journal lock poisoned",
                )
            })?
            .read(after_seq, max_bytes)
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::HostUnreachable, e))?;
        batch.incarnation_id = incarnation_id;
        batch.exited = self.exited();
        batch.exit_code = self.exited().then(|| self.exit_code());
        batch.native_session_id = self
            .native_session_id
            .lock()
            .ok()
            .and_then(|session| session.clone());
        Ok(batch)
    }

    pub fn stop(&mut self) {
        self.pty.kill();
    }
    pub fn pid(&self) -> u32 {
        self.pty.pid().unwrap_or(0)
    }
    pub fn exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }
    pub fn exit_code(&self) -> i64 {
        self.exit_code.load(Ordering::SeqCst)
    }
    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }
    pub fn stream_epoch(&self) -> &str {
        &self.stream_epoch
    }
    pub fn head_seq(&self) -> u64 {
        self.output.lock().map(|j| j.head_seq()).unwrap_or(0)
    }
    pub fn spool_bytes(&self) -> u64 {
        self.output.lock().map(|j| j.spool_bytes()).unwrap_or(0)
    }
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn select_opencode_session(
    rows: &[OpencodeSessionRow],
    cwd: &str,
    floor_ms: i64,
) -> Option<String> {
    let mut matches = rows.iter().filter(|row| {
        row.has_three_views_marker != Some(1)
            && row.created_at.is_some_and(|created| created >= floor_ms)
            && row
                .cwd
                .as_deref()
                .is_some_and(|candidate| paths_equivalent(candidate, cwd))
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first.session_id.clone())
}

fn paths_equivalent(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left = std::fs::canonicalize(left).ok();
    let right = std::fs::canonicalize(right).ok();
    left.is_some() && left == right
}

fn spawn_opencode_identity_watcher(
    launch: &TerminalLaunchSpec,
    floor_ms: i64,
    native_session_id: Arc<Mutex<Option<String>>>,
    _exited: Arc<AtomicBool>,
) {
    let data_home = launch
        .env
        .get("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/home/freshell/provider/.local/share"))
        .join("opencode");
    let cwd = launch.cwd.clone();
    let terminal_id = launch.terminal_id.clone();
    let uid = launch.run_as_uid;
    let gid = launch.run_as_gid;
    let Ok(exe) = std::env::current_exe() else {
        tracing::warn!(terminal_id = %terminal_id, "managed_opencode.identity_helper_exe_unavailable");
        return;
    };
    let _ = thread::Builder::new()
        .name(format!(
            "opencode-id-{}",
            terminal_id.chars().take(12).collect::<String>()
        ))
        .spawn(move || {
            let mut command = std::process::Command::new("/usr/bin/setpriv");
            command
                .arg("--reuid")
                .arg(uid.to_string())
                .arg("--regid")
                .arg(gid.to_string())
                .arg("--clear-groups")
                .arg("--no-new-privs")
                .arg("--")
                .arg(exe)
                .arg("opencode-identity-worker")
                .arg("--data-home")
                .arg(data_home)
                .arg("--cwd")
                .arg(cwd)
                .arg("--floor-ms")
                .arg(floor_ms.to_string())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            match command.output() {
                Ok(output) if output.status.success() => {
                    let session_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if session_id.starts_with("ses_") {
                        if let Ok(mut slot) = native_session_id.lock() {
                            *slot = Some(session_id.clone());
                        }
                        tracing::info!(terminal_id = %terminal_id, session_id = %session_id,
                            "managed_opencode.native_session_discovered");
                    }
                }
                Ok(output) => {
                    tracing::debug!(terminal_id = %terminal_id, status = ?output.status.code(),
                    "managed_opencode.identity_helper_exited_without_identity")
                }
                Err(error) => tracing::warn!(terminal_id = %terminal_id, error = %error,
                    "managed_opencode.identity_helper_spawn_failed"),
            }
        });
}

pub(crate) fn run_opencode_identity_worker(args: &[String]) -> Result<(), String> {
    let data_home = worker_arg(args, "--data-home")?;
    let cwd = worker_arg(args, "--cwd")?;
    let floor_ms: i64 = worker_arg(args, "--floor-ms")?
        .parse()
        .map_err(|error| format!("invalid --floor-ms: {error}"))?;
    let provider = OpencodeProvider::new(PathBuf::from(data_home));
    // A provider can sit idle before its first turn, so this helper is allowed
    // to wait. It lives inside the soul cgroup and disappears with the enclosure.
    for _ in 0..14_400 {
        match provider.list_sessions_since(floor_ms, 32) {
            Ok(rows) => {
                if let Some(session_id) = select_opencode_session(&rows, &cwd, floor_ms) {
                    println!("{session_id}");
                    return Ok(());
                }
            }
            Err(error) => {
                tracing::debug!(error = %error, "managed_opencode.identity_worker_deferred")
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("timed out waiting for OpenCode native session identity".into())
}

fn worker_arg(args: &[String], name: &str) -> Result<String, String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .ok_or_else(|| format!("missing {name}"))
}

#[cfg(test)]
mod managed_opencode_identity_tests {
    use super::select_opencode_session;
    use freshell_sessions::parse::opencode::OpencodeSessionRow;

    fn row(id: &str, cwd: &str, created_at: i64) -> OpencodeSessionRow {
        OpencodeSessionRow {
            session_id: id.to_string(),
            cwd: Some(cwd.to_string()),
            title: None,
            created_at: Some(created_at),
            last_activity_at: Some(created_at),
            project_path: Some(cwd.to_string()),
            has_three_views_marker: Some(0),
        }
    }

    #[test]
    fn selects_exactly_one_new_matching_root_session_and_refuses_ambiguity() {
        let rows = vec![
            row("ses_old", "/repo", 900),
            row("ses_other", "/other", 1_100),
            row("ses_new", "/repo", 1_200),
        ];
        assert_eq!(
            select_opencode_session(&rows, "/repo", 1_000),
            Some("ses_new".into())
        );

        let ambiguous = vec![row("ses_a", "/repo", 1_100), row("ses_b", "/repo", 1_200)];
        assert_eq!(select_opencode_session(&ambiguous, "/repo", 1_000), None);
    }
}
