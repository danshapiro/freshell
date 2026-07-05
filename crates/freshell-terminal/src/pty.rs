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
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::decode::Utf8StreamDecoder;
use crate::framing::{reassemble_stream, OutputFramer};

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
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    // Kept alive for the lifetime of the terminal so the master fd stays open.
    _master: Box<dyn portable_pty::MasterPty + Send>,
    reader_thread: Option<JoinHandle<()>>,
    captured: Arc<Mutex<Captured>>,
    terminal_id: String,
    stream_id: String,
    reaped: bool,
}

impl PtyTerminal {
    /// Spawn `spec` with the given fully-resolved child `env`, at `spec.cols` x
    /// `spec.rows`. `terminal_id`/`stream_id` label the framed output.
    pub fn spawn(
        spec: &SpawnSpec,
        env: &BTreeMap<String, String>,
        terminal_id: impl Into<String>,
        stream_id: impl Into<String>,
        ring_max_bytes: Option<i64>,
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

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        // node-pty *replaces* the environment: clear inherited, set the computed map.
        cmd.env_clear();
        for (key, value) in env {
            cmd.env(key, value);
        }
        if let Some(cwd) = &spec.cwd {
            cmd.cwd(cwd);
        }

        let child = pair.slave.spawn_command(cmd).map_err(to_io)?;
        // Drop the parent's slave handle so the master EOFs once the child exits.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(to_io)?;
        let writer = pair.master.take_writer().map_err(to_io)?;

        let captured = Arc::new(Mutex::new(Captured::default()));
        let framer = OutputFramer::new(terminal_id.clone(), stream_id.clone(), ring_max_bytes);
        let reader_thread = spawn_reader(reader, framer, Arc::clone(&captured));

        Ok(Self {
            child,
            writer,
            _master: pair.master,
            reader_thread: Some(reader_thread),
            captured,
            terminal_id,
            stream_id,
            reaped: false,
        })
    }

    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
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
        self.captured.lock().expect("captured mutex").messages.clone()
    }

    /// The seq-ordered, chunk-boundary-independent reassembly of this terminal's
    /// output stream (spec `§9.1`, the T1 thesis). Mirrors the capture harness.
    pub fn reassemble(&self) -> String {
        let messages = self.captured_messages();
        reassemble_stream(&messages, &self.stream_id)
    }

    /// SIGKILL + reap the child (`registry.kill`, `terminal-registry.ts:3997-4033`).
    /// Idempotent. Closing the child drops its slave fds so the reader thread EOFs.
    pub fn kill(&mut self) {
        if self.reaped {
            return;
        }
        self.reaped = true;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for PtyTerminal {
    fn drop(&mut self) {
        // Reap the child, then join the reader (it exits once the master EOFs).
        self.kill();
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
    }
}

/// The `onData` loop: read raw bytes -> decode UTF-8 (holding partial scalars) ->
/// frame into `terminal.output` messages -> append to the shared sink.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    mut framer: OutputFramer,
    captured: Arc<Mutex<Captured>>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut decoder = Utf8StreamDecoder::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: all slave fds closed (child exited)
                Ok(n) => {
                    let text = decoder.push(&buf[..n]);
                    if !text.is_empty() {
                        let messages = framer.append_output(&text);
                        if !messages.is_empty() {
                            captured.lock().expect("captured mutex").messages.extend(messages);
                        }
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
            let messages = framer.append_output(&tail);
            if !messages.is_empty() {
                captured.lock().expect("captured mutex").messages.extend(messages);
            }
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
        assert_eq!(env.get("FRESHELL_TERMINAL_ID").map(String::as_str), Some("t-123"));
    }
}
