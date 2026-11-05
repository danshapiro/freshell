//! Drive the real connection loop with per-connection keepalive ticks.
//!
//! No production timer or policy changes: this module and the ticker shadow
//! in run_loop exist only in the crate's unit-test build.

use std::cell::RefCell;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::time::{Instant, Interval};
use tokio_tungstenite::tungstenite::Message as ClientMessage;

tokio::task_local! {
    static MANUAL_TICKS: RefCell<Option<mpsc::UnboundedReceiver<()>>>;
}

pub(super) enum TickSource {
    Real(Interval),
    Manual(mpsc::UnboundedReceiver<()>),
}

impl TickSource {
    pub(super) fn new(real: Interval) -> Self {
        match MANUAL_TICKS.try_with(|ticks| ticks.borrow_mut().take()) {
            Ok(Some(ticks)) => Self::Manual(ticks),
            _ => Self::Real(real),
        }
    }

    pub(super) async fn tick(&mut self) -> Instant {
        match self {
            Self::Real(real) => real.tick().await,
            Self::Manual(ticks) => match ticks.recv().await {
                Some(()) => Instant::now(),
                // A dropped test driver never starts a hot loop or silently
                // falls back to real time. Socket close/shutdown still wakes
                // the connection's other select arms.
                None => std::future::pending().await,
            },
        }
    }
}

// Same watchdog as the existing real-socket handshake helper. This bounds
// transport failure; cycle advancement is entirely explicit below.
const IO_WATCHDOG: Duration = Duration::from_secs(5);
type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn send_frame(client: &mut Client, frame: ClientMessage) {
    tokio::time::timeout(IO_WATCHDOG, client.send(frame))
        .await
        .expect("websocket send within the existing I/O watchdog")
        .expect("websocket send succeeds");
}

async fn next_frame(client: &mut Client) -> ClientMessage {
    tokio::time::timeout(IO_WATCHDOG, client.next())
        .await
        .expect("websocket frame within the existing I/O watchdog")
        .expect("connection remains open")
        .expect("websocket frame is valid")
}

async fn next_json(client: &mut Client) -> serde_json::Value {
    match next_frame(client).await {
        ClientMessage::Text(text) => serde_json::from_str(&text).expect("JSON text frame"),
        other => panic!("expected an application frame, got {other:?}"),
    }
}

struct OwnedServer {
    listener: tokio::task::AbortHandle,
    shutdown: Arc<Notify>,
}

impl Drop for OwnedServer {
    fn drop(&mut self) {
        // One connection only: notify_one retains a permit if setup panics
        // before run_loop has entered its shutdown select arm.
        self.shutdown.notify_one();
        self.listener.abort();
    }
}

#[tokio::test]
async fn wire_pongs_keep_the_connection_alive_across_four_manual_cycles() {
    let mut state = super::pane_reconcile_gate_tests::state();
    state.ping_interval_ms = 30; // The old fixture's policy interval is unchanged.
    let token = state.auth_token.clone();
    let shutdown = state.shutdown.clone();
    let (ticks, tick_rx) = mpsc::unbounded_channel();
    let (done_tx, done_rx) = oneshot::channel();
    let connection = Arc::new(Mutex::new(Some((state, tick_rx, done_tx))));
    let router = axum::Router::new().route(
        "/ws",
        axum::routing::get(move |upgrade: axum::extract::ws::WebSocketUpgrade| {
            let connection = connection.clone();
            async move {
                let (state, tick_rx, done_tx) = connection
                    .lock()
                    .unwrap()
                    .take()
                    .expect("one owned websocket connection");
                upgrade.on_upgrade(move |socket| async move {
                    // Scope the concrete upgraded task, not the listener:
                    // Tokio task locals are intentionally not inherited by spawn.
                    MANUAL_TICKS
                        .scope(
                            RefCell::new(Some(tick_rx)),
                            crate::handle_socket(socket, state, None, None),
                        )
                        .await;
                    let _ = done_tx.send(());
                })
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind owned loopback listener");
    let addr = listener.local_addr().expect("owned listener address");
    let listener_task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve owned websocket fixture");
    });
    let _owner = OwnedServer {
        listener: listener_task.abort_handle(),
        shutdown,
    };
    let (mut client, _) = tokio::time::timeout(
        IO_WATCHDOG,
        tokio_tungstenite::connect_async(format!("ws://{addr}/ws")),
    )
    .await
    .expect("connect within the existing I/O watchdog")
    .expect("connect to owned websocket fixture");
    send_frame(
        &mut client,
        ClientMessage::Text(
            serde_json::json!({
                "type": "hello",
                "token": token.as_str(),
                "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            })
            .to_string(),
        ),
    )
    .await;
    for kind in [
        "ready",
        "settings.updated",
        "perf.logging",
        "terminal.inventory",
    ] {
        assert_eq!(next_json(&mut client).await["type"], kind);
    }

    for cycle in 0..4 {
        ticks
            .send(())
            .expect("connection owns its manual tick source");
        let payload = match next_frame(&mut client).await {
            ClientMessage::Ping(payload) => payload,
            other => panic!("cycle {cycle}: expected a server protocol Ping, got {other:?}"),
        };
        send_frame(&mut client, ClientMessage::Pong(payload)).await;
        // The application ping follows the protocol Pong on the same stream.
        // run_loop handles frames serially, so this reply proves the REAL
        // inbound Message::Pong arm ran before the next tick is released.
        send_frame(
            &mut client,
            ClientMessage::Text(r#"{"type":"ping"}"#.into()),
        )
        .await;
        assert_eq!(next_json(&mut client).await["type"], "pong");
    }
    // A fifth ping proves that the fourth Pong, too, retired its own cycle.
    // Removing inbound Pong handling closes the connection on tick two.
    ticks
        .send(())
        .expect("connection still owns the manual source");
    assert!(matches!(
        next_frame(&mut client).await,
        ClientMessage::Ping(_)
    ));

    send_frame(&mut client, ClientMessage::Close(None)).await;
    tokio::time::timeout(IO_WATCHDOG, done_rx)
        .await
        .expect("owned connection cleanup completes")
        .expect("owned connection returned normally");
    listener_task.abort();
    let _ = listener_task.await;
}
