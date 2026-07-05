//! `freshell-server` — the standalone headless server binary (the oracle SUT).
//!
//! Phase 3.4a: boot fast + clean on an ephemeral loopback port under the oracle
//! harness's env contract, then serve ONE axum app that answers `/api/health`
//! (freshell-api) and the connect handshake at `/ws` (freshell-ws). The handshake
//! must normalize-equal the original's (oracle T0). Terminal-over-wire, the rest
//! of REST, sessions, and the providers are later steps.
//!
//! ## Env contract (mirrors `test/e2e-browser/helpers/test-server.ts`)
//! * `PORT` — the ephemeral loopback port to bind (required in practice; the
//!   original defaults to 3001, mirrored here for a standalone run).
//! * `AUTH_TOKEN` — the required WS/REST auth token (refuse to start if absent,
//!   matching `auth.ts#getRequiredAuthToken`).
//! * `FRESHELL_BIND_HOST` — `127.0.0.1` (default/forced) or `0.0.0.0`; any other
//!   value is forced to loopback (mirrors `get-network-host.ts`).
//! * `FRESHELL_HOME` / `HOME` — the isolated home whose `.freshell/config.json`
//!   supplies the persisted `network` overlay for `settings.updated`.

mod settings;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use freshell_api::ApiState;
use freshell_freshagent::FreshAgentState;
use freshell_ws::WsState;
use uuid::Uuid;

use crate::settings::load_server_settings;

#[tokio::main]
async fn main() -> ExitCode {
    // AUTH_TOKEN is mandatory — refuse to start without it (matches the original).
    let auth_token = match std::env::var("AUTH_TOKEN") {
        Ok(token) if !token.is_empty() => Arc::new(token),
        _ => {
            eprintln!("AUTH_TOKEN is required. Refusing to start without authentication.");
            return ExitCode::FAILURE;
        }
    };

    let port = resolve_port();
    let bind_host = resolve_bind_host();
    let home = resolve_home();

    // Boot-scoped identifiers, stable for the life of the process (as in the
    // original's single `WsHandler`). Normalized away by the oracle.
    let server_instance_id = Arc::new(format!("srv-{}", Uuid::new_v4()));
    let boot_id = Arc::new(format!("boot-{}", Uuid::new_v4()));

    let settings = Arc::new(load_server_settings(home.as_deref()));

    // The shared server→client broadcast bus (pre-serialized frames). REST handlers
    // (fresh-agent create/send) push here; every `/ws` connection fans it out to its
    // socket — the original `WsHandler.broadcast`. Capacity is generous so a paced
    // fresh-agent turn's handful of broadcasts never laps a briefly-busy consumer.
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(1024).0);

    let ws_state = WsState {
        auth_token: Arc::clone(&auth_token),
        server_instance_id,
        boot_id,
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
    };
    let api_state = ApiState {
        auth_token: Arc::clone(&auth_token),
        ready: true,
    };
    // The fresh-agent REST surface (opencode slice): shares the auth token + the
    // broadcast bus so its create/send broadcasts reach every WS client.
    let fresh_agent_state = FreshAgentState::new(Arc::clone(&auth_token), Arc::clone(&broadcast_tx));

    // One axum app serving REST (`/api/health` + fresh-agent) + the WS upgrade (`/ws`).
    let app = freshell_api::router(api_state)
        .merge(freshell_ws::router(ws_state))
        .merge(freshell_freshagent::router(fresh_agent_state.clone()));

    let ip: IpAddr = bind_host.parse().unwrap_or(IpAddr::from([127, 0, 0, 1]));
    let addr = SocketAddr::new(ip, port);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("freshell-server: failed to bind {addr}: {err}");
            return ExitCode::FAILURE;
        }
    };
    // Single startup line (stderr, so it never pollutes any stdout protocol).
    eprintln!("freshell-server listening on http://{addr} (ws://{addr}/ws)");

    // Serve with graceful shutdown on SIGTERM/SIGINT so the fresh-agent opencode
    // serve sidecar is reaped (SIGTERM + `/proc` ownership sweep) — no orphans.
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    fresh_agent_state.shutdown().await;
    if let Err(err) = serve_result {
        eprintln!("freshell-server: serve error: {err}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// Resolve once a shutdown signal arrives (SIGTERM from the oracle harness's
/// `stop()`, or Ctrl-C). Drives `axum`'s graceful shutdown so the opencode serve
/// sidecar is reaped before exit.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            // If the SIGTERM handler cannot be installed, fall back to never-resolving
            // so Ctrl-C still drives shutdown.
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

/// Resolve the port to bind. Mirrors `server/index.ts`: `PORT` env or 3001.
fn resolve_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3001)
}

/// Resolve the bind host. Mirrors `get-network-host.ts`'s `FRESHELL_BIND_HOST`
/// override: honor an explicit `127.0.0.1` / `0.0.0.0`, otherwise force loopback.
fn resolve_bind_host() -> String {
    match std::env::var("FRESHELL_BIND_HOST").ok().as_deref() {
        Some("0.0.0.0") => "0.0.0.0".to_string(),
        _ => "127.0.0.1".to_string(),
    }
}

/// Resolve the isolated home whose `.freshell/config.json` supplies the network
/// overlay. `FRESHELL_HOME` takes precedence over `HOME` (matches the harness,
/// which sets both to the same temp dir).
fn resolve_home() -> Option<PathBuf> {
    std::env::var("FRESHELL_HOME")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}
