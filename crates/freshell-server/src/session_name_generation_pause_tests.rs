//! The naming pause on routes the scripted capability tests cannot reach:
//! a route whose packets are silently dropped (a firewall that answers
//! nothing, so the connect never completes). The real worker, the real
//! temp-file store and the real HTTP transport run against a loopback port
//! that drops every connect, in tokio virtual time (no wall-clock wait).

use std::time::Duration;

use super::capability_tests::{armed_target, generator, named, GENERATION_TARGET};
use super::tests::{
    document_json, generation_consumed, generation_status, open_store, temp_data_dir,
};
use super::GENERATION_REQUEST_TIMEOUT;
use crate::ai_title::AiKeyCell;
use crate::session_name_capability::tests::session_name_http;
use crate::session_name_capability::{KeyRouteTransport, LatchWindows, NamingRoute, PauseKind};
use crate::test_trace_capture::scoped_trace_capture;

/// A loopback port whose connects never complete, as behind a firewall that
/// silently drops packets: a listener that never accepts, with its accept
/// queue already full, so the kernel drops every further SYN instead of
/// answering it. (A refused connect fails at once and would not show what a
/// dropped one does.)
struct DroppedConnects {
    addr: std::net::SocketAddr,
    _listener: tokio::net::TcpListener,
    _queued: Vec<std::net::TcpStream>,
}

impl DroppedConnects {
    fn start() -> Self {
        let socket = tokio::net::TcpSocket::new_v4().expect("a socket");
        socket
            .bind("127.0.0.1:0".parse().unwrap())
            .expect("a loopback port");
        let listener = socket.listen(0).expect("listening");
        let addr = listener.local_addr().unwrap();
        let mut queued = Vec::new();
        // Fill the accept queue until a connect is dropped: that proves
        // every later connect to this port hangs too.
        for _ in 0..64 {
            match std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
                Ok(stream) => queued.push(stream),
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                    return Self {
                        addr,
                        _listener: listener,
                        _queued: queued,
                    };
                }
                Err(error) => panic!("filling the accept queue failed: {error}"),
            }
        }
        panic!("the accept queue never filled, so connects to it are not dropped");
    }

    fn base_url(&self) -> String {
        format!("http://{}/v1beta", self.addr)
    }

    fn proxy_url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

/// Run one due attempt and check it ended as a naming pause that used no
/// attempt: refunded, the series still eligible, the pause latched with
/// `code`, one WARN and no consumed-failure line — and all of it before the
/// worker's 20-second request bound would have charged the attempt.
async fn assert_dropped_connect_pauses(
    handle: &str,
    key: &str,
    base_url: &str,
    proxy: &str,
    route: NamingRoute,
    code: &str,
) {
    let (_guard, events) = scoped_trace_capture(GENERATION_TARGET);
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_target(&store, handle, "Name this session behind a firewall").await;
    let (auth, http) = session_name_http(
        AiKeyCell::init(Some(key.to_string()), None),
        base_url,
        Some(proxy),
    );
    assert_eq!(auth.route(), route);
    let generator = generator(dir.path(), auth, http, LatchWindows::default());
    let items = store.generation_work_snapshot();
    assert_eq!(items.len(), 1);

    let began = tokio::time::Instant::now();
    generator.run_due_attempt(&store, &items[0]).await;
    assert!(
        began.elapsed() < GENERATION_REQUEST_TIMEOUT,
        "the connect failed before the request bound ({:?})",
        began.elapsed()
    );

    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &target),
        0,
        "a dropped connect uses no attempt"
    );
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("eligible")
    );
    assert_eq!(generator.latch().pause_kind(), Some(PauseKind::Capability));
    let events = events.snapshot();
    let warnings = named(&events, "session_names.generation_capability_unavailable");
    assert_eq!(warnings.len(), 1, "one pause WARN: {events:#?}");
    assert_eq!(
        warnings[0].fields.get("code").map(String::as_str),
        Some(code)
    );
    assert!(
        named(&events, "session_names.generation_failed").is_empty(),
        "not a consumed failure: {events:#?}"
    );
}

/// Residual 19: a keyed request goes direct past a OneCLI-marked proxy; a
/// host whose firewall drops that direct route pauses naming with a
/// `direct_unreachable` WARN and uses no attempt.
#[tokio::test(start_paused = true)]
async fn a_dropped_direct_connect_pauses_naming_without_using_the_attempt() {
    let dropped = DroppedConnects::start();
    assert_dropped_connect_pauses(
        "h-dropped-direct",
        "dropped-direct-key",
        &dropped.base_url(),
        "http://aoc_unused_marker@127.0.0.1:9",
        NamingRoute::Key(KeyRouteTransport::Direct),
        "direct_unreachable",
    )
    .await;
}

/// The same through an ordinary ambient proxy that drops the connect.
#[tokio::test(start_paused = true)]
async fn a_dropped_proxy_connect_pauses_naming_without_using_the_attempt() {
    let dropped = DroppedConnects::start();
    assert_dropped_connect_pauses(
        "h-dropped-proxy",
        "dropped-proxy-key",
        "http://generativelanguage.googleapis.com/v1beta",
        &dropped.proxy_url(),
        NamingRoute::Key(KeyRouteTransport::AmbientProxy),
        "proxy_unreachable",
    )
    .await;
}
