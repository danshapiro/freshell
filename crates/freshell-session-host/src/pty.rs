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
use freshell_terminal::PtyTerminal;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex,
    },
};

pub struct HostedPty {
    pty: PtyTerminal,
    output: Arc<Mutex<OutputJournal>>,
    commands: CommandJournal,
    exited: Arc<AtomicBool>,
    exit_code: Arc<AtomicI64>,
    terminal_id: String,
    stream_epoch: String,
}

impl HostedPty {
    pub fn spawn(
        state_dir: &Path,
        incarnation_id: IncarnationId,
        launch: &TerminalLaunchSpec,
    ) -> Result<Self, String> {
        launch.validate().map_err(|e| e.message)?;
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
        Ok(Self {
            pty,
            output,
            commands,
            exited,
            exit_code,
            terminal_id: launch.terminal_id.clone(),
            stream_epoch,
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
