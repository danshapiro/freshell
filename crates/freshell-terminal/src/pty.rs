//! Real pseudo-terminal spawn/read/write/reap via `portable-pty` — the
//! `freshell-terminal` analogue of the node-pty spawn site
//! (`terminal-registry.ts:1594-1600`) and the `onData` output path (`1681-1691`).
//!
//! ## What this does (spec `terminal-core.md §2`, `§9.1`)
//!
//! - Spawns the [`SpawnSpec`] program/args at 120x30 (defaults) with the exact
//!   child env the terminal layer assembles: `(parent env − STRIP_ENV) + env_overrides`
//!   ([`build_child_env`]). PTY name is fixed `xterm-256color` (portable-pty sets
//!   `TERM` itself; we also carry the spec's `TERM` override — identical value).
//! - A reader thread streams raw PTY bytes -> [`Utf8StreamDecoder`] -> the
//!   [`OutputFramer`], collecting frozen `terminal.output` messages. This mirrors
//!   node-pty's per-`onData` `appendOutputFrames` call.
//! - Input is written verbatim to the PTY master (`terminal.input` write path,
//!   `terminal-registry.ts:3888`; no wire reply).
//! - The child is **always reaped**: [`PtyTerminal::kill`] SIGKILLs + waits, and
//!   `Drop` kills and joins the reader thread. No orphan shells.
//!
//! ## Out of scope (3.3b / other crates)
//!
//! Resize/geometry-epoch, attach snapshot, the WS transport & backpressure, and the
//! coding-CLI lifecycle are not here. This is the shell PTY core only.

use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use freshell_platform::spawn::STRIP_ENV;
use freshell_platform::SpawnSpec;
use freshell_protocol::ServerMessage;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::decode::Utf8StreamDecoder;
use crate::framing::{reassemble_stream, OutputFramer};

/// A live output sink invoked by the reader thread for **every** framed
/// `terminal.output` message as it is produced (seq-ordered, single producer).
///
/// This is the streaming seam the WS transport layer (`freshell-ws`) uses to
/// forward output frames to an attached client the moment they arrive, in
/// addition to the crate's own in-memory capture (`captured_messages`). Kept as a
/// bare `FnMut` callback so `freshell-terminal` stays transport-agnostic (no tokio
/// dependency): the caller decides where each message goes (a channel, a buffer…).
pub type MessageSink = Box<dyn FnMut(ServerMessage) + Send>;

/// A hook the reader thread invokes exactly once when the PTY stream ends (the
/// master EOFs — natural child exit OR kill), with the child's exit code (the
/// node-pty `onExit({exitCode})` payload, `terminal-registry.ts:1751`). The ws
/// layer uses it for `cleanupMcpConfig` parity (`tr:1491`) and the natural-exit
/// `finishTerminalPtyExit` fan-out (`tr:1479-1510`). Fired from the READER
/// thread only after every produced byte has been framed (the exit code itself
/// comes from the waiter thread's `child.wait()` via a rendezvous channel), so
/// `terminal.exit` can never overtake the final `terminal.output` frames.
pub type ExitHook = Box<dyn FnOnce(i64) + Send>;

fn to_io<E: std::fmt::Display>(err: E) -> io::Error {
    io::Error::other(err.to_string())
}

/// `(parent env − STRIP_ENV) + spec.env_overrides` — the exact child environment the
/// reference passes to `pty.spawn` (`buildSpawnSpec`, `terminal-registry.ts:1083-1105`;
/// node-pty *replaces* the env with this map). `parent` is the caller's snapshot of
/// `process.env`.
pub fn build_child_env(
    parent: &BTreeMap<String, String>,
    spec: &SpawnSpec,
) -> BTreeMap<String, String> {
    let mut env = parent.clone();
    for key in STRIP_ENV {
        env.remove(*key);
    }
    for (key, value) in &spec.env_overrides {
        env.insert(key.clone(), value.clone());
    }
    env
}

/// [`build_child_env`] sourced from the live `process.env` (`std::env::vars`).
pub fn build_child_env_from_process(spec: &SpawnSpec) -> BTreeMap<String, String> {
    let parent: BTreeMap<String, String> = std::env::vars().collect();
    build_child_env(&parent, spec)
}

/// Shared sink the reader thread appends captured wire messages to.
#[derive(Debug, Default)]
struct Captured {
    messages: Vec<ServerMessage>,
}

/// A live shell PTY: the spawned child, the master writer, and a background reader
/// that frames output into `terminal.output` messages.
pub struct PtyTerminal {
    // Kill handle for the child (the child itself is owned by `waiter_thread`,
    // which blocks in `child.wait()` \u2014 the node-pty agent's process-exit wait).
    killer: Box<dyn ChildKiller + Send + Sync>,
    writer: Box<dyn Write + Send>,
    // Kept alive for the lifetime of the terminal so the master fd stays open.
    // Shared with the waiter thread: on WINDOWS the waiter drops it when the
    // child exits, because a ConPTY master read NEVER EOFs on child death alone
    // (only `ClosePseudoConsole` \u2014 i.e. dropping the master \u2014 EOFs the reader).
    // Live-pinned 2026-07-13 on the native-Windows server: without this,
    // `registry.kill` joined a reader that never EOF'd and wedged the server,
    // and natural child exit was never detected. node-pty parity: its Windows
    // agent waits on the process handle, fires onExit, and closes the pty.
    // On unix the master stays open until Drop so the reader drains every
    // pending byte and EOFs via EIO exactly as before (T1 golden semantics).
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    waiter_thread: Option<JoinHandle<()>>,
    reader_thread: Option<JoinHandle<()>>,
    captured: Arc<Mutex<Captured>>,
    terminal_id: String,
    stream_id: String,
    reaped: bool,
    // SAFE-11/TERM-22: the pty child's own pid (unix only; `None` on windows or
    // if the library can't report it), captured before the `Child` handle moves
    // into `waiter_thread`. `kill()` uses it to additionally signal the WHOLE
    // process GROUP (`-pid`), not just this single process -- see `kill`'s doc
    // comment for why `killer.kill()` alone is not sufficient.
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: Option<u32>,
}

impl PtyTerminal {
    /// Spawn `spec` with the given fully-resolved child `env`, at `spec.cols` x
    /// `spec.rows`. `terminal_id`/`stream_id` label the framed output.
    ///
    /// The output is captured in-memory only (query via [`captured_messages`] /
    /// [`reassemble`]). For live streaming to a WS client, use
    /// [`spawn_with_sink`](Self::spawn_with_sink).
    pub fn spawn(
        spec: &SpawnSpec,
        env: &BTreeMap<String, String>,
        terminal_id: impl Into<String>,
        stream_id: impl Into<String>,
        ring_max_bytes: Option<i64>,
    ) -> io::Result<Self> {
        Self::spawn_with_sink(
            spec,
            env,
            terminal_id,
            stream_id,
            ring_max_bytes,
            None,
            None,
        )
    }

    /// As [`spawn`](Self::spawn), but the reader thread also forwards every framed
    /// `terminal.output` message to `sink` the moment it is produced (in seq order,
    /// single producer), in addition to the in-memory capture. This is the seam the
    /// WS transport uses to stream output to an attached client.
    pub fn spawn_with_sink(
        spec: &SpawnSpec,
        env: &BTreeMap<String, String>,
        terminal_id: impl Into<String>,
        stream_id: impl Into<String>,
        ring_max_bytes: Option<i64>,
        sink: Option<MessageSink>,
        on_exit: Option<ExitHook>,
    ) -> io::Result<Self> {
        let terminal_id = terminal_id.into();
        let stream_id = stream_id.into();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(to_io)?;

        let build_cmd = |with_cwd: bool| {
            let mut cmd = CommandBuilder::new(&spec.program);
            cmd.args(&spec.args);
            // node-pty *replaces* the environment: clear inherited, set the computed map.
            cmd.env_clear();
            for (key, value) in env {
                cmd.env(key, value);
            }
            if with_cwd {
                if let Some(cwd) = &spec.cwd {
                    cmd.cwd(cwd);
                }
            }
            cmd
        };

        // DEV-0005 condition 4 (TOCTOU guard): if the spawn fails WITH a process cwd
        // (e.g. an inherited /mnt mount that vanished between the FileProbe check and
        // this spawn, or any cwd that stopped being a directory), log + degrade by
        // retrying once without the cwd (the child then inherits the server's cwd —
        // the reference's own behavior on WSL) instead of surfacing a raw spawn error
        // the original could never produce.
        let child = match pair.slave.spawn_command(build_cmd(true)) {
            Ok(child) => child,
            Err(err) if spec.cwd.is_some() => {
                eprintln!(
                    "[freshell-terminal] PTY spawn with cwd {:?} failed ({err}); degrading to cwd-less spawn (DEV-0005 TOCTOU guard)",
                    spec.cwd.as_deref().unwrap_or("")
                );
                pair.slave.spawn_command(build_cmd(false)).map_err(to_io)?
            }
            Err(err) => return Err(to_io(err)),
        };
        // Drop the parent's slave handle so the master EOFs once the child exits.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(to_io)?;
        let writer = pair.master.take_writer().map_err(to_io)?;

        let captured = Arc::new(Mutex::new(Captured::default()));
        let framer = OutputFramer::new(terminal_id.clone(), stream_id.clone(), ring_max_bytes);

        // The child is owned by a waiter thread that blocks in `wait()` (node-pty's
        // Windows agent does the same with RegisterWaitForSingleObject). On Windows
        // it then drops the master: ConPTY flushes pending output to the still-
        // draining reader and EOFs it \u2014 the ONLY way a ConPTY reader ever EOFs.
        // On unix the reader EOFs by itself (slave closed \u2192 EIO), and the master
        // must stay open until Drop so no pending output is truncated.
        let killer = child.clone_killer();
        // SAFE-11/TERM-22: captured BEFORE `child` moves into `waiter_thread`,
        // so `kill()` can additionally signal the whole process GROUP (see
        // `kill`'s doc comment).
        let pid = child.process_id();
        let master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
            Arc::new(Mutex::new(Some(pair.master)));
        let waiter_master = Arc::clone(&master);
        let (code_tx, code_rx) = std::sync::mpsc::channel::<i64>();
        let mut child = child;
        let waiter_thread = std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i64,
                Err(_) => 0,
            };
            let _ = code_tx.send(code);
            if cfg!(windows) {
                waiter_master.lock().expect("master mutex").take();
            }
        });
        let reader_thread = spawn_reader(
            reader,
            framer,
            Arc::clone(&captured),
            sink,
            on_exit,
            code_rx,
        );

        Ok(Self {
            killer,
            writer,
            master,
            waiter_thread: Some(waiter_thread),
            reader_thread: Some(reader_thread),
            captured,
            terminal_id,
            stream_id,
            reaped: false,
            pid,
        })
    }

    /// Resize the PTY window (`terminal.resize` write path,
    /// `terminal-registry.ts:3989` `pty.resize(cols,rows)`). Errors are swallowed
    /// exactly as the reference swallows node-pty resize errors.
    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(master) = self.master.lock().expect("master mutex").as_ref() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }

    /// The pty child's OS pid (unix only; `None` on windows or after
    /// [`mark_naturally_exited`](Self::mark_naturally_exited) drops the
    /// cached value). DIAG-01: surfaced in the registry's `terminal.created`
    /// lifecycle event for process-ownership context.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    /// `terminal.input` write path (`terminal-registry.ts:3888`): write bytes to the
    /// PTY master; no wire reply.
    pub fn write_input(&mut self, data: &[u8]) -> io::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    /// Snapshot of all captured `terminal.output` messages so far.
    pub fn captured_messages(&self) -> Vec<ServerMessage> {
        self.captured
            .lock()
            .expect("captured mutex")
            .messages
            .clone()
    }

    /// The seq-ordered, chunk-boundary-independent reassembly of this terminal's
    /// output stream (spec `§9.1`, the T1 thesis). Mirrors the capture harness.
    pub fn reassemble(&self) -> String {
        let messages = self.captured_messages();
        reassemble_stream(&messages, &self.stream_id)
    }

    /// SIGKILL the child (`registry.kill`, `terminal-registry.ts:3997-4033`).
    /// Idempotent. The waiter thread reaps it (`child.wait()`) and \u2014 on Windows \u2014
    /// closes the ConPTY master so the reader thread EOFs; on unix the child's
    /// death closes its slave fds and the reader EOFs via EIO after draining.
    ///
    /// SAFE-11/TERM-22: `self.killer.kill()` alone only signals the pty's
    /// DIRECT child (the shell). A foreground command that child itself
    /// spawned (e.g. a user typing `sleep 300`) is a SEPARATE process in the
    /// SAME process group, not a target of that single-pid signal. Relying
    /// solely on it left such a command orphaned in exactly the shutdown
    /// scenario this fix closes (verified empirically: an intermittent
    /// leaked descendant pid under `scripts/sandbox-test.sh`, racing against
    /// the incidental SIGHUP a pty master's close delivers to its foreground
    /// group -- present on unix, but never guaranteed, and absent on
    /// Windows). SIGKILL to the NEGATIVE pid (the whole process group) closes
    /// that gap: it reaches the shell AND every process it spawned into its
    /// own foreground group, deterministically, without depending on the
    /// pty's own hangup semantics.
    pub fn kill(&mut self) {
        if self.reaped {
            return;
        }
        self.reaped = true;
        let _ = self.killer.kill();
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // SAFE-11/TERM-22 stale-pid hardening: record the pid this
            // instance is ABOUT to group-signal (test-only observability
            // seam -- see `take_group_kill_log`) before actually sending it,
            // so a test can assert this branch was (or wasn't) reached
            // without having to inspect real process state.
            #[cfg(test)]
            record_group_kill(pid);
            // SAFETY: `libc::kill` with a negative pid signals the whole
            // process group rooted at that pid; a process's own group is
            // always safe to signal (we only ever signal a group WE
            // spawned). Best-effort: ESRCH (already gone) is expected and
            // ignored, matching `killer.kill()`'s own idempotent contract.
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }
    }

    /// SAFE-11/TERM-22 (stale-pid group-kill hardening): mark this
    /// `PtyTerminal` as already reaped and invalidate its cached OS pid,
    /// WITHOUT touching the killer or joining any thread. Called from
    /// `TerminalRegistry::finish_pty_exit` the moment a child exits
    /// NATURALLY -- which runs from inside this very instance's reader
    /// thread (see that function's doc comment), so joining
    /// `reader_thread`/`waiter_thread` here would deadlock. Idempotent.
    ///
    /// Why this exists: a terminal that exits naturally is RETAINED in the
    /// registry (not removed), so its `PtyTerminal` can still be reached by
    /// a LATER, unrelated `kill()` (e.g. `TerminalRegistry::kill_all`'s
    /// shutdown sweep, which walks every tracked id, including
    /// retained-exited ones). Between this natural exit and that later
    /// call, the OS is free to recycle this struct's cached `pid` to a
    /// completely unrelated process (and process group) leader. Without
    /// this guard, `kill()` would still attempt
    /// `libc::kill(-pid, SIGKILL)` against that now-stale, recycled pid --
    /// SIGKILLing an innocent process group. Setting `reaped = true` makes
    /// `kill()` a guaranteed no-op (its very first line); clearing `pid` is
    /// a second, independent guard against the same class of bug even if
    /// that check were ever removed or bypassed.
    pub(crate) fn mark_naturally_exited(&mut self) {
        self.reaped = true;
        self.pid = None;
    }
}

// SAFE-11/TERM-22 test-only signal-recording seam: records every pid this
// process ACTUALLY attempted to group-kill via `PtyTerminal::kill`, so tests
// can assert a group-kill was (positive control) or was NOT (the stale-pid
// regression this hardens against) attempted, without needing to inspect
// real OS process state. Thread-local so parallel `cargo test` runs (each
// test gets its own thread by default) never interfere with each other.
#[cfg(test)]
thread_local! {
    static GROUP_KILL_LOG: std::cell::RefCell<Vec<u32>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn record_group_kill(pid: u32) {
    GROUP_KILL_LOG.with(|log| log.borrow_mut().push(pid));
}

/// Drain and return every pid recorded by [`record_group_kill`] on the
/// CURRENT thread so far (test-only).
#[cfg(test)]
pub(crate) fn take_group_kill_log() -> Vec<u32> {
    GROUP_KILL_LOG.with(|log| std::mem::take(&mut *log.borrow_mut()))
}

impl Drop for PtyTerminal {
    fn drop(&mut self) {
        // Kill the child, then join the waiter (returns once the child is reaped;
        // on Windows it also closes the master) and the reader (it exits once the
        // stream EOFs \u2014 unix: slave EIO; Windows: master closed by the waiter).
        // Both joins are bounded: kill() guarantees the child is exiting.
        self.kill();
        if let Some(handle) = self.waiter_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
    }
}

/// The `onData` loop: read raw bytes -> decode UTF-8 (holding partial scalars) ->
/// frame into `terminal.output` messages -> append to the in-memory capture AND
/// (when present) forward each message to the live streaming `sink`.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    mut framer: OutputFramer,
    captured: Arc<Mutex<Captured>>,
    mut sink: Option<MessageSink>,
    on_exit: Option<ExitHook>,
    code_rx: std::sync::mpsc::Receiver<i64>,
) -> JoinHandle<()> {
    // Capture in-memory and (if wired) forward each framed message to the live sink.
    // The sink sees frames in the SAME seq order they are appended (single producer).
    let mut emit = move |messages: Vec<ServerMessage>| {
        if messages.is_empty() {
            return;
        }
        if let Some(sink) = sink.as_mut() {
            for message in &messages {
                sink(message.clone());
            }
        }
        captured
            .lock()
            .expect("captured mutex")
            .messages
            .extend(messages);
    };

    std::thread::spawn(move || {
        let mut decoder = Utf8StreamDecoder::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: all slave fds closed (child exited)
                Ok(n) => {
                    let text = decoder.push(&buf[..n]);
                    if !text.is_empty() {
                        emit(framer.append_output(&text));
                    }
                }
                Err(ref e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // EIO on Linux when the slave side closes: treat as EOF.
                Err(_) => break,
            }
        }
        // Flush any trailing partial bytes at stream end (lossy).
        let tail = decoder.finish();
        if !tail.is_empty() {
            emit(framer.append_output(&tail));
        }
        // The PTY stream ended (natural child exit or kill) — run the exit hook
        // (`terminal-registry.ts:1491` cleanupMcpConfig + tr:1479 finishTerminalPtyExit
        // parity) with the exit code from the waiter thread. The recv is bounded:
        // stream EOF implies the child is exiting, so `child.wait()` completes and
        // the waiter always sends exactly once.
        if let Some(hook) = on_exit {
            let code = code_rx.recv().unwrap_or(0);
            hook(code);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_platform::spawn::{SpawnSpec, DEFAULT_COLS, DEFAULT_ROWS};

    fn spec_with_overrides(overrides: &[(&str, &str)]) -> SpawnSpec {
        let mut env_overrides = BTreeMap::new();
        for (k, v) in overrides {
            env_overrides.insert((*k).to_string(), (*v).to_string());
        }
        SpawnSpec {
            program: "/bin/bash".into(),
            args: vec!["-l".into()],
            env_overrides,
            cwd: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        }
    }

    #[test]
    fn build_child_env_strips_and_overrides() {
        let mut parent = BTreeMap::new();
        parent.insert("PATH".into(), "/usr/bin".into());
        parent.insert("CI".into(), "1".into()); // in STRIP_ENV
        parent.insert("NODE_ENV".into(), "production".into()); // in STRIP_ENV
        parent.insert("TERM".into(), "dumb".into()); // overridden below
        parent.insert("HOME".into(), "/home/u".into());

        let spec = spec_with_overrides(&[
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "en_US.UTF-8"),
            ("FRESHELL_TERMINAL_ID", "t-123"),
        ]);

        let env = build_child_env(&parent, &spec);
        // Stripped.
        assert!(!env.contains_key("CI"));
        assert!(!env.contains_key("NODE_ENV"));
        // Preserved.
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/u"));
        // Overridden (override wins over inherited TERM=dumb).
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("LANG").map(String::as_str), Some("en_US.UTF-8"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("en_US.UTF-8"));
        assert_eq!(
            env.get("FRESHELL_TERMINAL_ID").map(String::as_str),
            Some("t-123")
        );
    }
}
