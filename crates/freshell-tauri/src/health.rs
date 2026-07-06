//! Health-gate for the spawned server — the Rust analog of
//! `server-spawner.ts`'s `pollHealthCheck` (`server-spawner.ts:46-81`).
//!
//! Behavior preserved 1:1: poll `GET /api/health`; on 200 resolve; otherwise wait
//! with **exponential backoff starting at 100 ms, doubling, capped at 5 s**; **fail
//! fast if the child process exited**; overall **30 s** timeout
//! (`architecture-spec.md:188`). The core [`poll_health`] loop is generic over the
//! probe / child-liveness / sleep / clock so it is unit-tested headlessly with
//! injected fakes (no real socket, no real time). [`wait_for_health`] wires it to a
//! real loopback TCP probe + the real clock.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Backoff bounds — the exact constants from `server-spawner.ts:48,76`.
pub const INITIAL_BACKOFF: Duration = Duration::from_millis(100);
pub const MAX_BACKOFF: Duration = Duration::from_millis(5000);
/// Overall health-gate timeout — `architecture-spec.md:188` (`server-spawner.ts` default 30 s).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Result of a single `/api/health` probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthProbe {
    /// `/api/health` returned 200.
    Ready,
    /// Connection refused / non-200 / timeout — retry after backoff.
    NotReady,
}

/// Why the health-gate gave up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthError {
    /// The child process exited before `/api/health` went green (fail-fast,
    /// `server-spawner.ts:52-54`).
    ChildExited,
    /// The overall timeout elapsed without a healthy probe.
    Timeout(Duration),
}

impl std::fmt::Display for HealthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HealthError::ChildExited => {
                write!(f, "server process exited before health check succeeded")
            }
            HealthError::Timeout(d) => write!(f, "health check timed out after {}ms", d.as_millis()),
        }
    }
}

impl std::error::Error for HealthError {}

/// Next backoff delay: double, capped at [`MAX_BACKOFF`]
/// (`server-spawner.ts:76` `Math.min(delay * 2, 5000)`).
pub fn next_backoff(current: Duration) -> Duration {
    (current * 2).min(MAX_BACKOFF)
}

/// The generic health-poll loop. Mirrors `pollHealthCheck`:
/// while `elapsed() < timeout` — fail fast if `child_exited()`, else `probe()`;
/// on `Ready` return Ok, on `NotReady` `sleep_for(delay)` and back off. After the
/// window, `Err(Timeout)`.
///
/// All four effects are injected so the loop is deterministic under test.
pub fn poll_health<P, E, S, T>(
    mut probe: P,
    mut child_exited: E,
    mut sleep_for: S,
    mut elapsed: T,
    timeout: Duration,
) -> Result<(), HealthError>
where
    P: FnMut() -> HealthProbe,
    E: FnMut() -> bool,
    S: FnMut(Duration),
    T: FnMut() -> Duration,
{
    let mut delay = INITIAL_BACKOFF;
    while elapsed() < timeout {
        if child_exited() {
            return Err(HealthError::ChildExited);
        }
        match probe() {
            HealthProbe::Ready => return Ok(()),
            HealthProbe::NotReady => {
                sleep_for(delay);
                delay = next_backoff(delay);
            }
        }
    }
    Err(HealthError::Timeout(timeout))
}

/// Real single probe: open a loopback TCP connection and issue a minimal
/// `GET /api/health` HTTP/1.1 request, returning [`HealthProbe::Ready`] iff the
/// status line is `200`. Dependency-free (no HTTP client crate) — the health
/// endpoint is unauthenticated (`freshell-server` `/api/health`).
pub fn http_probe(host: &str, port: u16) -> HealthProbe {
    match http_probe_inner(host, port) {
        Ok(true) => HealthProbe::Ready,
        _ => HealthProbe::NotReady,
    }
}

fn http_probe_inner(host: &str, port: u16) -> std::io::Result<bool> {
    let mut stream = TcpStream::connect((host, port))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;
    let mut buf = [0u8; 128];
    let n = stream.read(&mut buf)?;
    let head = String::from_utf8_lossy(&buf[..n]);
    // Status line: `HTTP/1.1 200 OK`.
    Ok(head
        .lines()
        .next()
        .map(|line| line.contains(" 200"))
        .unwrap_or(false))
}

/// Wait for the server to become healthy using the real loopback probe + clock.
/// `child_exited` reports whether the spawned server has died (fail-fast). This is
/// the runtime wiring of [`poll_health`].
pub fn wait_for_health<E>(
    host: &str,
    port: u16,
    timeout: Duration,
    child_exited: E,
) -> Result<(), HealthError>
where
    E: FnMut() -> bool,
{
    let start = Instant::now();
    poll_health(
        || http_probe(host, port),
        child_exited,
        std::thread::sleep,
        || start.elapsed(),
        timeout,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn backoff_doubles_then_caps_at_5s() {
        assert_eq!(next_backoff(Duration::from_millis(100)), Duration::from_millis(200));
        assert_eq!(next_backoff(Duration::from_millis(200)), Duration::from_millis(400));
        assert_eq!(next_backoff(Duration::from_millis(2500)), Duration::from_millis(5000));
        // Cap holds.
        assert_eq!(next_backoff(Duration::from_millis(5000)), Duration::from_millis(5000));
        assert_eq!(next_backoff(Duration::from_millis(4000)), Duration::from_millis(5000));
    }

    #[test]
    fn poll_returns_ok_when_probe_becomes_ready_and_backs_off() {
        // A shared virtual clock advanced by the injected sleep.
        let clock = Cell::new(Duration::ZERO);
        let attempts = Cell::new(0u32);
        let slept: std::cell::RefCell<Vec<Duration>> = std::cell::RefCell::new(Vec::new());

        let result = poll_health(
            || {
                let n = attempts.get();
                attempts.set(n + 1);
                // NotReady twice, then Ready on the 3rd probe.
                if n < 2 { HealthProbe::NotReady } else { HealthProbe::Ready }
            },
            || false,
            |d| {
                slept.borrow_mut().push(d);
                clock.set(clock.get() + d);
            },
            || clock.get(),
            Duration::from_secs(30),
        );

        assert!(result.is_ok());
        assert_eq!(attempts.get(), 3);
        // Backoff sequence for the two waits: 100ms, then 200ms.
        assert_eq!(
            *slept.borrow(),
            vec![Duration::from_millis(100), Duration::from_millis(200)]
        );
    }

    #[test]
    fn poll_fails_fast_when_child_exits() {
        let probed = Cell::new(false);
        let result = poll_health(
            || {
                probed.set(true);
                HealthProbe::NotReady
            },
            || true, // child already exited
            |_| {},
            || Duration::ZERO,
            Duration::from_secs(30),
        );
        assert_eq!(result, Err(HealthError::ChildExited));
        assert!(!probed.get(), "must fail before probing when the child is dead");
    }

    #[test]
    fn poll_times_out_when_never_ready() {
        let clock = Cell::new(Duration::ZERO);
        let result = poll_health(
            || HealthProbe::NotReady,
            || false,
            |d| clock.set(clock.get() + d),
            || clock.get(),
            Duration::from_millis(1000),
        );
        assert_eq!(result, Err(HealthError::Timeout(Duration::from_millis(1000))));
    }

    #[test]
    fn timeout_that_is_already_elapsed_probes_zero_times() {
        let probed = Cell::new(0u32);
        let result = poll_health(
            || {
                probed.set(probed.get() + 1);
                HealthProbe::Ready
            },
            || false,
            |_| {},
            || Duration::from_secs(31), // already past the 30s window
            DEFAULT_TIMEOUT,
        );
        assert_eq!(result, Err(HealthError::Timeout(DEFAULT_TIMEOUT)));
        assert_eq!(probed.get(), 0);
    }

    #[test]
    fn http_probe_reports_notready_on_closed_port() {
        // Nothing is listening on this ephemeral port → NotReady, never a panic.
        let free = crate::server::allocate_ephemeral_port().unwrap();
        assert_eq!(http_probe("127.0.0.1", free), HealthProbe::NotReady);
    }

    #[test]
    fn http_probe_reports_ready_against_a_200_stub() {
        use std::net::TcpListener;
        // Stand up a one-shot loopback server that answers /api/health with 200.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = sock.read(&mut buf);
                let _ = sock.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                );
            }
        });
        assert_eq!(http_probe("127.0.0.1", port), HealthProbe::Ready);
        let _ = handle.join();
    }
}
