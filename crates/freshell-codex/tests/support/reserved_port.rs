//! A loopback port no other socket is given while a test holds it
//! ([`ReservedPort`], Linux). One copy serves both kinds of test: the
//! integration tests include it through `lost_port.rs`, and the crate's unit
//! tests through `src/sidecar_test_support.rs`. So it uses nothing of this
//! crate's own.

/// A loopback port no other socket can take while this value lives (Linux).
/// A test holds one where a port it bound and released could be given to
/// another socket before the test is done with it:
///
/// - A start the product drives on a port the test names
///   (`SpawnedCodexAppServerRuntime::with_forced_listen_port`). A start that
///   cannot be retried after a lost port (a seeded start with a disabled
///   store: the product kills its launcher as the start fails, before its
///   fake can say it lost the port) runs on one, so it has no port to lose.
/// - A URL where nothing listens, which a test expects a dial to be refused
///   at. No other test's app-server or proxy can answer there.
///
/// Why nothing else is given the port:
///
/// - The port lies outside the kernel's ephemeral range
///   ([`ephemeral_port_range`]). The kernel never gives it to a socket that
///   binds port 0 or connects, and the product, which allocates its ports
///   by binding port 0, never chooses it for another start.
/// - It was free when reserved: this socket bound it without
///   `SO_REUSEADDR`, which fails while any other socket holds it, so two
///   reservations never share a port.
/// - Then this socket allows `SO_REUSEADDR` and never listens, so the fake
///   (Node binds with `SO_REUSEADDR`) binds and listens on it. A socket that
///   does not listen answers no probe and is no listener a start could find.
///
/// Only a program that binds this exact port by number while it is reserved
/// could take it.
pub struct ReservedPort {
    port: u16,
    _socket: tokio::net::TcpSocket,
}

impl Default for ReservedPort {
    fn default() -> Self {
        Self::new()
    }
}

impl ReservedPort {
    /// Reserves a free loopback port outside the kernel's ephemeral range.
    pub fn new() -> Self {
        use std::hash::{BuildHasher, Hasher};
        let candidates = ports_outside_the_ephemeral_range();
        let span = u64::from(candidates.end() - candidates.start()) + 1;
        for _ in 0..1000 {
            let pick = std::collections::hash_map::RandomState::new()
                .build_hasher()
                .finish()
                % span;
            let port = candidates.start() + u16::try_from(pick).expect("a port in the band");
            let socket = tokio::net::TcpSocket::new_v4().expect("a socket to reserve a port");
            if socket
                .bind(std::net::SocketAddr::from(([127, 0, 0, 1], port)))
                .is_err()
            {
                continue; // Another socket holds it.
            }
            socket
                .set_reuseaddr(true)
                .expect("the reserved port admits the fake's bind");
            return Self {
                port,
                _socket: socket,
            };
        }
        panic!("no free loopback port in {candidates:?} to reserve after 1000 tries");
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

/// The kernel's ephemeral port range (`/proc/sys/net/ipv4/ip_local_port_range`):
/// the ports it chooses for a socket that binds port 0 or connects.
pub fn ephemeral_port_range() -> std::ops::RangeInclusive<u16> {
    let raw = std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range")
        .expect("the kernel's ephemeral port range");
    let bounds: Vec<u16> = raw
        .split_whitespace()
        .map(|bound| bound.parse().expect("a port number"))
        .collect();
    let [low, high] = bounds[..] else {
        panic!("ip_local_port_range is two port numbers: {raw:?}");
    };
    low..=high
}

/// Ports the kernel never chooses by itself, away from the well-known
/// service ports: those above its ephemeral range (`61000..=65535` with the
/// usual `32768 60999`), or else the 1024 just below it.
fn ports_outside_the_ephemeral_range() -> std::ops::RangeInclusive<u16> {
    let ephemeral = ephemeral_port_range();
    let (low, high) = (*ephemeral.start(), *ephemeral.end());
    if high <= u16::MAX - 1024 {
        high + 1..=u16::MAX
    } else {
        assert!(
            low >= 10_000 + 1024,
            "no ports outside the ephemeral range {ephemeral:?} to reserve"
        );
        low - 1024..=low - 1
    }
}
