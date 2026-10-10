//! Shared helpers for the Windows suites. Every process here is one the test
//! started (directly or as a descendant): a [`Proc`] handle pins it, so it
//! never reaches a recycled pid, and anything still running when its `Proc`
//! drops is terminated through that handle (a failing test leaves nothing
//! running).
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use freshell_containment::{process, ShimCommand};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

pub const SHIM: &str = env!("CARGO_BIN_EXE_freshell-unit-exec");
pub const HELPER: &str = env!("CARGO_BIN_EXE_freshell-test-helper");
/// How long a child may take to print an expected line (a cold runner
/// starts Node slowly).
pub const LINE_WAIT: Duration = Duration::from_secs(60);
/// How long a terminated process may take to be signalled.
pub const EXIT_WAIT: Duration = Duration::from_secs(10);

/// The test build of the `__unit-exec` shim (the server passes its own exe).
pub fn test_shim() -> ShimCommand {
    ShimCommand {
        exe: SHIM.into(),
        leading_args: Vec::new(),
    }
}

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A JavaScript string literal for `s` (JSON strings are valid JS).
pub fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

/// A handle to one process the test started.
pub struct Proc {
    pub handle: HANDLE,
    pub pid: u32,
}

// SAFETY: a process handle is a plain kernel handle, usable from any thread.
unsafe impl Send for Proc {}
unsafe impl Sync for Proc {}

impl Proc {
    pub fn open(pid: u32) -> Self {
        // SAFETY: plain OpenProcess; the result is checked.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        assert!(
            !handle.is_null(),
            "OpenProcess({pid}): {}",
            std::io::Error::last_os_error()
        );
        Self { handle, pid }
    }

    /// True once the process has exited within `limit`.
    pub fn wait(&self, limit: Duration) -> bool {
        // SAFETY: a live handle with SYNCHRONIZE.
        let rc = unsafe { WaitForSingleObject(self.handle, limit.as_millis() as u32) };
        assert!(
            rc == WAIT_OBJECT_0 || rc == WAIT_TIMEOUT,
            "WaitForSingleObject({}): {rc}",
            self.pid
        );
        rc == WAIT_OBJECT_0
    }

    pub fn running(&self) -> bool {
        !self.wait(Duration::ZERO)
    }

    pub fn terminate(&self) {
        // SAFETY: a live handle with PROCESS_TERMINATE.
        let ok = unsafe { TerminateProcess(self.handle, 1) };
        assert!(
            ok != 0 || !self.running(),
            "TerminateProcess({}): {}",
            self.pid,
            std::io::Error::last_os_error()
        );
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        // SAFETY: the handle is ours and closed once; terminating an exited
        // process is a harmless error.
        unsafe {
            if WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT {
                TerminateProcess(self.handle, 1);
            }
            CloseHandle(self.handle);
        }
    }
}

/// The lines a child prints, read on their own thread.
pub struct Lines {
    rx: mpsc::Receiver<String>,
    pub seen: Vec<String>,
}

impl Lines {
    pub fn new(out: impl Read + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                if tx.send(line.trim_end().to_string()).is_err() {
                    break;
                }
            }
        });
        Self {
            rx,
            seen: Vec::new(),
        }
    }

    /// The first new line that `matches`; `None` when the output ends
    /// first. Panics at `LINE_WAIT`.
    pub fn next_matching(&mut self, what: &str, matches: impl Fn(&str) -> bool) -> Option<String> {
        let deadline = Instant::now() + LINE_WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(line) => {
                    self.seen.push(line.clone());
                    if matches(&line) {
                        return Some(line);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return None,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("no {what} line within {LINE_WAIT:?}; seen: {:?}", self.seen)
                }
            }
        }
    }

    pub fn expect(&mut self, what: &str, matches: impl Fn(&str) -> bool) -> String {
        match self.next_matching(what, matches) {
            Some(line) => line,
            None => panic!("output ended before a {what} line; seen: {:?}", self.seen),
        }
    }

    /// The pid after `prefix` on the first line starting with it.
    pub fn expect_pid(&mut self, prefix: &str) -> u32 {
        let line = self.expect(prefix, |l| l.starts_with(prefix));
        parse_pid(&line, prefix)
    }
}

/// The lines a tokio child prints, read by their own task.
pub struct AsyncLines {
    rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    pub seen: Vec<String>,
}

impl AsyncLines {
    pub fn new(out: tokio::process::ChildStdout) -> Self {
        use tokio::io::AsyncBufReadExt;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line.trim_end().to_string()).is_err() {
                    break;
                }
            }
        });
        Self {
            rx,
            seen: Vec::new(),
        }
    }

    pub async fn expect(&mut self, what: &str, matches: impl Fn(&str) -> bool) -> String {
        let wait = async {
            while let Some(line) = self.rx.recv().await {
                self.seen.push(line.clone());
                if matches(&line) {
                    return Some(line);
                }
            }
            None
        };
        match tokio::time::timeout(LINE_WAIT, wait).await {
            Ok(Some(line)) => line,
            Ok(None) => panic!("output ended before a {what} line; seen: {:?}", self.seen),
            Err(_) => panic!("no {what} line within {LINE_WAIT:?}; seen: {:?}", self.seen),
        }
    }

    pub async fn expect_pid(&mut self, prefix: &str) -> u32 {
        let line = self.expect(prefix, |l| l.starts_with(prefix)).await;
        parse_pid(&line, prefix)
    }
}

fn parse_pid(line: &str, prefix: &str) -> u32 {
    line[prefix.len()..]
        .split_whitespace()
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| panic!("malformed line {line:?}"))
}

/// The first direct child of `parent` whose image is `name`.
pub fn child_named(parent: u32, name: &str) -> Option<u32> {
    process::children(parent)
        .into_iter()
        .find(|pid| process::name(*pid).is_ok_and(|n| n.eq_ignore_ascii_case(name)))
}

/// Captures every `freshell_unit` event of this test binary (a global
/// subscriber: the unit logs from tokio worker threads and the job
/// backend's port thread). Tests filter by their own unit id.
pub fn captured() -> Captured {
    static CAPTURED: OnceLock<Captured> = OnceLock::new();
    CAPTURED
        .get_or_init(|| {
            use tracing_subscriber::prelude::*;
            let captured = Captured::default();
            tracing::subscriber::set_global_default(
                tracing_subscriber::registry().with(captured.clone()),
            )
            .expect("the first global subscriber of this test binary");
            captured
        })
        .clone()
}

/// One captured event: its `event` name and every other field as text.
#[derive(Clone, Debug)]
pub struct Event {
    pub level: tracing::Level,
    pub event: String,
    pub fields: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Default)]
pub struct Captured(pub Arc<Mutex<Vec<Event>>>);

impl Captured {
    /// The events named `event` of the unit `unit_id`.
    pub fn of_unit(&self, unit_id: &str, event: &str) -> Vec<Event> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                e.event == event && e.fields.get("unit_id").map(String::as_str) == Some(unit_id)
            })
            .cloned()
            .collect()
    }
}

#[derive(Default)]
struct Fields(std::collections::BTreeMap<String, String>);

impl tracing::field::Visit for Fields {
    fn record_str(&mut self, f: &tracing::field::Field, v: &str) {
        self.0.insert(f.name().to_string(), v.to_string());
    }
    fn record_debug(&mut self, f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
        self.0.insert(
            f.name().to_string(),
            format!("{v:?}").trim_matches('"').to_string(),
        );
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Captured {
    fn on_event(&self, e: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let mut fields = Fields::default();
        e.record(&mut fields);
        if let Some(name) = fields.0.remove("event") {
            self.0.lock().unwrap().push(Event {
                level: *e.metadata().level(),
                event: name,
                fields: fields.0,
            });
        }
    }
}
