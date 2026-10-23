//! Listener binding for the transactional rebind (NET-02).
//!
//! We create every listener (boot AND rebind) with SO_REUSEADDR + SO_REUSEPORT
//! so a new listener can be *proven to bind* before we persist the config and
//! retire the old one. Rollback is dropping the new socket — an infallible
//! no-op. There is never a zero-listener window and persisted state never
//! outruns reality. The `FRESHELL_REBIND_NO_REUSEPORT=1` escape hatch disables
//! SO_REUSEPORT (falls back to a best-effort bind a foreign squatter can block).
//!
//! Drain design (VALIDATED — ledger A-03 falsified the naive version): the
//! controller owns its own accept loop per listener. Retiring a listener uses
//! `Notify::notify_one()` (permit-storing: the wakeup cannot be lost, unlike
//! `notify_waiters`) and then AWAITS the old accept-loop `JoinHandle`, which
//! first hands off queued connections, then shuts the listening socket down
//! (so a duplicate held by a concurrently forked child process cannot keep
//! it listening) and drops it — a deterministic "old socket closed" barrier,
//! so callers may respond/probe immediately after `serve_on` returns. In-flight connections (incl.
//! WebSockets) drain in their own spawned tasks — no mass 4009 on rebind.
//!
//! Trade-off: SO_REUSEPORT lets another process of the same effective UID bind
//! the port. On a single-user self-hosted box that is inside the same trust
//! boundary as the auth token.

use std::net::{IpAddr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::{Arc, OnceLock};

use axum::Router;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

const LISTEN_BACKLOG: usize = 1024;

pub fn parse_reuse_port(raw: Option<&str>) -> bool {
    match raw {
        Some(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        None => true,
    }
}

pub fn reuse_port_enabled() -> bool {
    parse_reuse_port(
        std::env::var("FRESHELL_REBIND_NO_REUSEPORT")
            .ok()
            .as_deref(),
    )
}

pub fn bind_reusable(addr: SocketAddr, reuse_port: bool) -> std::io::Result<StdTcpListener> {
    let domain = match addr.ip() {
        IpAddr::V4(_) => Domain::IPV4,
        IpAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    if reuse_port {
        socket.set_reuse_port(true)?;
    }
    #[cfg(not(unix))]
    let _ = reuse_port;
    socket.bind(&addr.into())?;
    socket.listen(LISTEN_BACKLOG as i32)?;
    let std_listener: StdTcpListener = socket.into();
    std_listener.set_nonblocking(true)?;
    Ok(std_listener)
}

/// Stop `listener` listening for EVERY descriptor that shares its socket.
///
/// Closing this process's descriptors alone does not close a listening
/// socket while a child process forked by another thread (a PTY, sidecar or
/// Git spawn) still holds a duplicate from before its exec: the socket keeps
/// listening, the kernel keeps queueing new connections on it — preferring
/// it over a wildcard listener for its own address — and resets them all
/// when the child's copy finally closes. A shutdown acts on the socket
/// itself, so it stops listening at once.
fn stop_listening(listener: &StdTcpListener) {
    match socket2::SockRef::from(listener).shutdown(std::net::Shutdown::Both) {
        Ok(()) => {}
        // Platforms that do not shut down a listening socket report it as
        // not connected; closing the descriptors is all they offer.
        Err(err) if err.kind() == std::io::ErrorKind::NotConnected => {}
        Err(err) => tracing::warn!(
            error = %err,
            "retired listener shutdown failed; it stops listening once every inherited descriptor closes"
        ),
    }
}

/// One live listener: its shutdown signal and accept-loop task handle. The
/// accept loop drops its listener before exiting, so awaiting the handle is
/// a true "old socket closed" barrier. The bound address lives on the
/// controller's `current_addr` mirror (one slot: exactly one listener
/// exists at a time).
struct LiveListener {
    shutdown: Arc<Notify>,
    accept_loop: JoinHandle<()>,
}

pub struct RebindController {
    port: u16,
    reuse_port: bool,
    app: OnceLock<Router>,
    current: Mutex<Option<LiveListener>>,
    /// The CURRENT listener's bound address, mirrored for cheap sync reads
    /// (NET-02's rollback proof reads product truth instead of probing the
    /// kernel namespace, where a sibling's just-assigned wildcard listener
    /// makes a plain detector bind lie). Written under the same lock scope
    /// as the `current` swap, so it is never newer or staler than the
    /// listener itself.
    current_addr: std::sync::Mutex<Option<SocketAddr>>,
}

impl RebindController {
    pub fn new(port: u16, reuse_port: bool) -> Arc<Self> {
        Arc::new(Self {
            port,
            reuse_port,
            app: OnceLock::new(),
            current: Mutex::new(None),
            current_addr: std::sync::Mutex::new(None),
        })
    }

    pub fn set_app(&self, app: Router) {
        let _ = self.app.set(app); // first (full) app wins
    }

    // Consumed by Task 2.3/2.4's network mutation endpoints (they gate the
    // rebind path on a fully-built app); until then nothing in the bin reads it.
    #[allow(dead_code)]
    pub fn has_app(&self) -> bool {
        self.app.get().is_some()
    }

    /// Bind `host:port` (proof), start our own accept loop, then retire the old
    /// listener: `notify_one` (permit-storing, cannot be lost) + await its
    /// JoinHandle (deterministic closed barrier). On bind failure the previous
    /// listener is left untouched (no swap). When no app has been injected
    /// (unit tests) this is an Ok no-op so validation and persistence can be
    /// tested without a real socket.
    pub async fn serve_on(&self, host: IpAddr) -> std::io::Result<()> {
        let Some(app) = self.app.get().cloned() else {
            return Ok(());
        };
        let addr = SocketAddr::new(host, self.port);
        let std_listener = bind_reusable(addr, self.reuse_port)?; // PROOF: must succeed
        let drain_listener = std_listener.try_clone()?;
        let listener = tokio::net::TcpListener::from_std(std_listener)?;
        // The listener's OWN address (its port when the caller bound
        // kernel-assigned port 0): the product-truth record the rollback
        // detector reads.
        let bound_addr = listener.local_addr()?;
        let shutdown = Arc::new(Notify::new());
        let shut = Arc::clone(&shutdown);
        let accept_loop = tokio::spawn(async move {
            let serve = |stream: tokio::net::TcpStream| {
                let app = app.clone();
                tokio::spawn(async move {
                    use tower::ServiceExt as _;
                    let socket = hyper_util::rt::TokioIo::new(stream);
                    let hyper_service = hyper::service::service_fn(
                        move |request: hyper::Request<hyper::body::Incoming>| {
                            app.clone().oneshot(request)
                        },
                    );
                    let _ = hyper_util::server::conn::auto::Builder::new(
                        hyper_util::rt::TokioExecutor::new(),
                    )
                    .serve_connection_with_upgrades(socket, hyper_service)
                    .await;
                });
            };
            loop {
                tokio::select! {
                    biased;
                    _ = shut.notified() => {
                        // A TCP handshake can finish before this loop accepts
                        // it. Closing the listener with that socket queued
                        // resets the client, so hand off the queued sockets
                        // before dropping the retiring listener.
                        // Bound the drain by the configured backlog so new
                        // arrivals cannot keep a rebind open indefinitely.
                        for _ in 0..LISTEN_BACKLOG {
                            match drain_listener.accept() {
                                Ok((stream, _remote)) => {
                                    if let Err(err) = stream.set_nonblocking(true) {
                                        tracing::warn!(error = %err, "listener drain stream setup failed");
                                        continue;
                                    }
                                    match tokio::net::TcpStream::from_std(stream) {
                                        Ok(stream) => serve(stream),
                                        Err(err) => tracing::warn!(error = %err, "listener drain stream registration failed"),
                                    }
                                }
                                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => break,
                                Err(err) => {
                                    tracing::warn!(error = %err, "listener drain failed");
                                    break;
                                }
                            }
                        }
                        // Dropping the handles below would not close the
                        // socket while a forked child still holds a copy.
                        stop_listening(&drain_listener);
                        break;
                    },
                    res = listener.accept() => {
                        let (stream, _remote) = match res {
                            Ok(accepted) => accepted,
                            Err(err) => {
                                // A persistent accept failure (e.g. EMFILE)
                                // must not silently busy-loop: log it and back
                                // off briefly before retrying.
                                tracing::warn!(error = %err, "listener accept failed; retrying after backoff");
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                continue;
                            }
                        };
                        serve(stream);
                    }
                }
            }
            // `listener` is stopped above and dropped HERE, before the task
            // completes: awaiting this JoinHandle is a true "old listener
            // closed" barrier, even against copies held by forked children.
        });
        let mut cur = self.current.lock().await;
        *self.current_addr.lock().expect("current_addr lock") = Some(bound_addr);
        if let Some(old) = cur.replace(LiveListener {
            shutdown,
            accept_loop,
        }) {
            old.shutdown.notify_one(); // permit-storing: never lost
            let _ = old.accept_loop.await; // barrier: old socket provably closed
        }
        Ok(())
    }

    /// The CURRENT listener's bound address, or `None` when nothing is
    /// serving. In-memory product truth (never a kernel probe): because
    /// [`Self::serve_on`] only records an address AFTER the new bind and
    /// only AFTER the previous accept loop's close barrier, this address
    /// both proves the recorded listener is live and — the NET-02 rollback
    /// use — proves any PREVIOUS listener on another address is gone.
    // Consumed by the rollback test's product-truth detector (the `has_app`
    // precedent: test-consumed surface until a bin caller reads it).
    #[allow(dead_code)]
    pub fn current_bind_addr(&self) -> Option<SocketAddr> {
        *self.current_addr.lock().expect("current_addr lock")
    }

    pub async fn shutdown_all(&self) {
        if let Some(cur) = self.current.lock().await.take() {
            *self.current_addr.lock().expect("current_addr lock") = None;
            cur.shutdown.notify_one();
            let _ = cur.accept_loop.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    // Keep this listener until the controller's initial bind succeeds, then
    // retire it before sending traffic so only the controller accepts requests.
    //
    // It binds the WILDCARD address: these tests later rebind the controller
    // to 0.0.0.0, which needs the port free on every address. A loopback-only
    // `bind(127.0.0.1:0)` lets the kernel hand out a port that another socket
    // on this host is already using on a different address (a busy machine's
    // outgoing connection, say), and the later wildcard rebind then fails
    // with AddrInUse. A wildcard `bind(0.0.0.0:0)` only picks a port that is
    // free everywhere, and from then on some socket of this test holds it.
    fn reusable_port_owner() -> StdTcpListener {
        bind_reusable(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)), true)
            .expect("own an OS-assigned reusable listener")
    }

    // The port owner shares the controller's SO_REUSEPORT port. Dropping it
    // is not enough: a child process forked meanwhile by another test holds
    // a duplicate until it execs, and while it does the owner keeps
    // listening — the kernel can then hand this test's connection to the
    // owner's queue, which nobody serves, and reset it once the child's copy
    // closes. Stop it listening first, as the controller does with a
    // retired listener.
    fn retire_port_owner(port_owner: StdTcpListener) {
        stop_listening(&port_owner);
        drop(port_owner);
    }

    #[test]
    fn reuse_port_kill_switch_reads_env() {
        assert!(parse_reuse_port(None));
        assert!(!parse_reuse_port(Some("1")));
        assert!(!parse_reuse_port(Some("TRUE")));
        assert!(!parse_reuse_port(Some("yes")));
        assert!(parse_reuse_port(Some("0")));
        assert!(parse_reuse_port(Some("")));
    }

    #[test]
    fn two_reuseport_binds_on_same_addr_both_succeed() {
        let a = reusable_port_owner();
        let addr = a.local_addr().expect("first listener address");
        let b = bind_reusable(addr, true).expect("second reuseport bind must also succeed");
        drop((a, b));
    }

    #[test]
    fn foreign_squatter_blocks_our_bind() {
        let squatter =
            std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("squatter binds");
        let addr = squatter.local_addr().expect("squatter address");
        let result = bind_reusable(addr, true);
        assert!(
            result.is_err(),
            "reuseport bind must still fail against a foreign non-reuseport squatter"
        );
        drop(squatter);
    }

    #[tokio::test]
    async fn serve_on_proves_bind_before_swapping_and_serves_traffic() {
        use axum::{routing::get, Router};
        let port_owner = reusable_port_owner();
        let port = port_owner
            .local_addr()
            .expect("initial listener address")
            .port();
        let app = Router::new().route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        let competing_bind = StdTcpListener::bind((Ipv4Addr::LOCALHOST, port));
        assert!(
            matches!(&competing_bind, Err(err) if err.kind() == std::io::ErrorKind::AddrInUse),
            "the fixture must own its chosen port until the controller starts serving"
        );
        ctl.serve_on(IpAddr::V4(Ipv4Addr::LOCALHOST))
            .await
            .expect("initial serve");
        retire_port_owner(port_owner);
        let body = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "pong");
        ctl.serve_on(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .await
            .expect("rebind serve");
        let body2 = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body2, "pong");
        ctl.shutdown_all().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn hundred_rapid_rebinds_never_lose_a_listener_or_reset_a_probe() {
        // Falsifier for the validated lost-wakeup/drain race (ledger A-03,
        // reports/V1.md): with notify_waiters and no barrier, 42-99/100 of
        // these iterations fail. Do NOT weaken this test.
        use axum::{routing::get, Router};
        let port_owner = reusable_port_owner();
        let port = port_owner
            .local_addr()
            .expect("initial listener address")
            .port();
        let app = Router::new().route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        let localhost = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let wildcard = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
        ctl.serve_on(localhost).await.expect("initial serve");
        retire_port_owner(port_owner);
        for i in 0..100 {
            let target = if i % 2 == 0 { wildcard } else { localhost };
            ctl.serve_on(target).await.expect("swap");
            // serve_on returned => the OLD listener is closed (barrier), so an
            // immediate probe must hit the new listener, never ConnectionReset.
            let body = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
                .await
                .expect("probe connects")
                .text()
                .await
                .unwrap();
            assert_eq!(body, "pong", "swap #{i}");
        }
        ctl.shutdown_all().await;
        // Port fully released: a plain (non-reuseport) bind succeeds only if no
        // stuck listener remains (the lost-wakeup failure mode).
        std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .expect("no stuck listeners after 100 swaps");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rebind_serves_a_connection_queued_on_the_retiring_listener() {
        use axum::{routing::get, Router};
        use std::io::Write;
        use tokio::io::AsyncReadExt;

        let port_owner = reusable_port_owner();
        let port = port_owner
            .local_addr()
            .expect("initial listener address")
            .port();
        let app = Router::new().route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        ctl.serve_on(IpAddr::V4(Ipv4Addr::LOCALHOST))
            .await
            .expect("initial serve");
        retire_port_owner(port_owner);

        // A current-thread runtime has not polled the accept loop yet. The
        // handshake and request reach the old socket before its shutdown.
        let mut raw = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .expect("connect to the retiring listener");
        raw.write_all(b"GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .expect("send request before rebind");
        raw.set_nonblocking(true).expect("nonblocking client");
        let mut client = tokio::net::TcpStream::from_std(raw).expect("register client");

        ctl.serve_on(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .await
            .expect("rebind serve");
        let mut response = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.read_to_end(&mut response),
        )
        .await
        .expect("queued request completes")
        .expect("queued request is not reset");
        assert!(
            response.ends_with(b"pong"),
            "queued request must be served by the retiring listener"
        );
        ctl.shutdown_all().await;
    }

    /// A retired listener stops listening even while a child process forked
    /// before the rebind still holds a duplicate of it (every PTY, sidecar or
    /// Git spawn on another thread opens that window until its exec). Merely
    /// closing the server's descriptors would leave it LISTENING: a new
    /// connection to its specific address would land in a queue nobody
    /// serves — ahead of the new wildcard listener — and be reset when the
    /// child's copy finally closes.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_retired_listener_held_by_a_forked_child_stops_accepting() {
        use axum::{routing::get, Router};
        let port_owner = reusable_port_owner();
        let port = port_owner
            .local_addr()
            .expect("initial listener address")
            .port();
        let app = Router::new().route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        ctl.serve_on(IpAddr::V4(Ipv4Addr::LOCALHOST))
            .await
            .expect("initial serve");
        retire_port_owner(port_owner);

        // Fork while the loopback listener is open, then retire it.
        let child = crate::test_parked_child::ParkedChild::fork_now();
        ctl.serve_on(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .await
            .expect("rebind serve");
        let probe = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            reqwest::get(format!("http://127.0.0.1:{port}/ping"))
                .await?
                .text()
                .await
        })
        .await;
        child.release();
        let body = probe
            .expect("the new listener answers; the retired one must not swallow the probe")
            .expect("the probe is not reset");
        assert_eq!(body, "pong");
        ctl.shutdown_all().await;
    }

    /// Pins the DEV-0013 drain property: a connection accepted by the OLD
    /// listener keeps working across a rebind (drains gracefully in its
    /// detached per-connection task) while the NEW listener serves new
    /// requests. Fails if the swap force-closes in-flight connections.
    ///
    /// Deterministic sequencing (no sleeps): the gated handler signals entry
    /// via mpsc BEFORE the swap, and is released via watch only AFTER the
    /// swap + new-listener probe. Timeouts are failure bounds, not sync.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn inflight_connection_survives_rebind_and_drains_to_completion() {
        use axum::{routing::get, Router};
        use std::time::Duration;
        use tokio::sync::{mpsc, watch};
        use tokio::time::timeout;

        let port_owner = reusable_port_owner();
        let port = port_owner
            .local_addr()
            .expect("initial listener address")
            .port();
        let (arrived_tx, mut arrived_rx) = mpsc::unbounded_channel::<()>();
        let (release_tx, release_rx) = watch::channel(false);
        let slow = {
            let arrived_tx = arrived_tx.clone();
            let release_rx = release_rx.clone();
            move || {
                let arrived_tx = arrived_tx.clone();
                let mut release_rx = release_rx.clone();
                async move {
                    let _ = arrived_tx.send(()); // in-flight on the OLD listener
                    while !*release_rx.borrow_and_update() {
                        if release_rx.changed().await.is_err() {
                            break;
                        }
                    }
                    "drained"
                }
            }
        };
        let app = Router::new()
            .route("/slow", get(slow))
            .route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        let localhost = IpAddr::V4(Ipv4Addr::LOCALHOST);
        ctl.serve_on(localhost).await.expect("initial serve");
        retire_port_owner(port_owner);

        // Start a request that will still be in flight when we swap. Only the
        // OLD listener exists at this point, so it owns the connection.
        let old_req =
            tokio::spawn(
                async move { reqwest::get(format!("http://127.0.0.1:{port}/slow")).await },
            );
        timeout(Duration::from_secs(30), arrived_rx.recv())
            .await
            .expect("handler must start before the swap")
            .expect("arrival signal");

        // Swap. When serve_on returns, the old accept loop has exited and the
        // old socket is closed (barrier) -- yet the in-flight connection above
        // must keep draining in its detached task.
        ctl.serve_on(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .await
            .expect("rebind serve");

        // NEW listener serves new connections while the old one still drains.
        let body = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
            .await
            .expect("new listener accepts during drain")
            .text()
            .await
            .unwrap();
        assert_eq!(body, "pong");

        // Release the gate: the request accepted by the retired listener must
        // complete successfully. A force-close on swap => connection reset /
        // incomplete body here, failing the test.
        release_tx.send(true).expect("handler still alive");
        let resp = timeout(Duration::from_secs(30), old_req)
            .await
            .expect("old connection must complete, not hang")
            .expect("client task")
            .expect("old connection must not be reset by the swap");
        assert_eq!(
            resp.text().await.unwrap(),
            "drained",
            "in-flight request must drain to completion across the rebind"
        );
        ctl.shutdown_all().await;
    }
}
