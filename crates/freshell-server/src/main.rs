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

mod boot;
mod extensions;
mod files;
mod network;
mod proxy;
mod screenshots;
mod serve_client;
mod session_directory;
mod settings;

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use freshell_api::ApiState;
use freshell_freshagent::FreshAgentState;
use freshell_platform::detect::{detect_platform_proc, host_os_live, read_proc_version};
use freshell_ws::WsState;
use uuid::Uuid;

use crate::boot::BootState;
use crate::settings::load_server_settings;

/// App version reported by `GET /api/version` (mirrors `package.json` `version`).
/// Overridable via `FRESHELL_APP_VERSION` for parity when a run needs it.
const APP_VERSION: &str = "0.7.0";

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

    // The shared UI-screenshot broker over that same bus: `POST /api/screenshots`
    // registers a request + broadcasts `screenshot.capture`; the `/ws` loop routes
    // the capable client's `ui.screenshot.result` back. Shared by value into WsState
    // (capability tracking + result routing) and the screenshots REST state.
    let screenshots = freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx));

    // The freshcodex WS fresh-agent slice: shares the auth token + the broadcast bus so its
    // freshAgent.created/send.accepted/event frames reach every WS client (incl. the oracle's
    // capture socket). Seeded with the settings tree so `PATCH /api/settings` returns/merges it.
    let fresh_codex_state = freshell_freshagent::FreshCodexState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
        serde_json::to_value(settings.as_ref()).unwrap_or_else(|_| serde_json::json!({})),
    );

    // The freshclaude WS fresh-agent slice: shares the broadcast bus so its
    // freshAgent.created/send.accepted/event frames reach every WS client (incl. the
    // oracle's capture socket). It drives the ONE sanctioned Node claude sidecar; the
    // create gate is the SHARED settings.freshAgent.enabled flag (owned by fresh_codex).
    let fresh_claude_state = freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx));

    // The shared, connection-independent terminal registry: terminals are owned by
    // `terminalId` here (not by the socket that created them), so a second/reconnected
    // socket re-attaches to a running PTY and replays its scrollback. This is what
    // makes the multi-client / reconnection / hot-across-reload flows work.
    // Cloned (cheap Arc) into the files REST surface too, whose `candidate-dirs`
    // sources the running terminals' cwds for the DirectoryPicker.
    let registry = freshell_terminal::TerminalRegistry::new();
    // The shared in-memory tabs registry — cloned into both the WS handler
    // (`tabs.sync.*`) and the boot REST surface (`/api/tabs-sync/client-retire`),
    // so the unload beacon and the socket path retire against ONE cross-device view.
    let tabs = freshell_ws::tabs::TabsRegistry::new();
    let ws_state = WsState {
        auth_token: Arc::clone(&auth_token),
        server_instance_id,
        boot_id,
        settings: Arc::clone(&settings),
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: fresh_codex_state.clone(),
        fresh_claude: fresh_claude_state.clone(),
        registry: registry.clone(),
        tabs: tabs.clone(),
        screenshots: screenshots.clone(),
    };
    let api_state = ApiState {
        auth_token: Arc::clone(&auth_token),
        ready: true,
    };
    // The fresh-agent REST surface (opencode slice): shares the auth token + the
    // broadcast bus so its create/send broadcasts reach every WS client.
    let fresh_agent_state = FreshAgentState::new(Arc::clone(&auth_token), Arc::clone(&broadcast_tx));

    // Follow-up 3.19: discover the CLI extensions (bundled `extensions/` +
    // user/local dirs) and detect which coding-CLI agents are on PATH, so the
    // PanePicker surfaces the real claude/codex/opencode agents (was `{}`). The
    // client registry feeds `GET /api/extensions`; `availableClis` feeds the
    // platform payload (`/api/platform` + `bootstrap.platform`).
    let extension_registry =
        extensions::ExtensionRegistry::scan(&extensions::resolve_extension_dirs(home.as_deref()));
    let available_clis =
        extensions::detect_available_clis_live(&extension_registry.cli_detection_specs());
    let extensions_registry = Arc::new(extension_registry.to_client_registry());

    // The boot REST surface the RETAINED React SPA fetches on first paint
    // (bootstrap/platform/version/settings/session-directory/terminals/network),
    // and the resolved `dist/client` dir the SPA is served from.
    let boot_state = BootState {
        auth_token: Arc::clone(&auth_token),
        settings: Arc::clone(&settings),
        platform: Arc::new(build_platform_payload(available_clis)),
        app_version: Arc::new(
            std::env::var("FRESHELL_APP_VERSION").unwrap_or_else(|_| APP_VERSION.to_string()),
        ),
        tabs: tabs.clone(),
        extensions: Arc::clone(&extensions_registry),
    };
    // The read-only network status surface (`GET /api/network/status`, Follow-up
    // 3.19): the full `NetworkStatus` shape, with firewall/LAN facts detected
    // lazily via READ-ONLY probes and cached. `effective_host` is the actual bind.
    let network_state = network::NetworkState {
        auth_token: Arc::clone(&auth_token),
        settings: Arc::clone(&settings),
        effective_host: Arc::new(bind_host.clone()),
        port,
        facts: Arc::new(tokio::sync::OnceCell::new()),
    };

    // The History read model (`GET /api/session-directory`, Follow-up 3.19): list
    // the coding-CLI sessions from the isolated home's provider transcript dirs,
    // reusing `freshell-sessions` parsers. Replaces the earlier empty-page stub.
    let session_directory_state = session_directory::SessionDirectoryState {
        auth_token: Arc::clone(&auth_token),
        home: home.clone(),
    };

    let client_dir = Arc::new(resolve_client_dir());

    // The files REST surface the RETAINED SPA's DirectoryPicker fetches when a
    // browser user opens a Fresh Agent pane (candidate dirs + validate-dir). Shares
    // the auth token, the settings tree (for `defaultCwd`), and the terminal
    // registry (for the running terminals' cwds).
    let files_state = files::FilesState {
        auth_token: Arc::clone(&auth_token),
        settings: Arc::clone(&settings),
        registry: registry.clone(),
    };

    // The browser-pane HTTP reverse proxy (`/api/proxy/http/{port}/*`): the SPA's
    // BrowserPane rewrites loopback URLs to this same-origin path so its iframe can
    // render dev-server content with the iframe-blocking headers stripped.
    let proxy_state = proxy::ProxyState::new(Arc::clone(&auth_token));

    // The agent screenshot endpoint (`POST /api/screenshots`): drives the WS
    // `screenshot.capture` round-trip through the shared broker and writes the PNG.
    let screenshots_state = screenshots::ScreenshotsState {
        auth_token: Arc::clone(&auth_token),
        broker: screenshots.clone(),
    };

    // One axum app serving REST (`/api/health` + fresh-agent + `PATCH /api/settings`
    // + the SPA boot endpoints + files) + the WS upgrade (`/ws`) + static
    // `dist/client` with SPA-fallback routing. The fallback also returns a clean 404
    // for any unmatched `/api/*` (never the HTML shell), mirroring the original ordering.
    let app = freshell_api::router(api_state)
        .merge(freshell_ws::router(ws_state))
        .merge(freshell_freshagent::router(fresh_agent_state.clone()))
        .merge(fresh_codex_state.settings_router())
        .merge(boot::router(boot_state))
        .merge(network::router(network_state))
        .merge(session_directory::router(session_directory_state))
        .merge(files::router(files_state))
        .merge(proxy::router(proxy_state))
        .merge(screenshots::router(screenshots_state))
        .fallback({
            let client_dir = Arc::clone(&client_dir);
            move |uri: axum::http::Uri| {
                let client_dir = Arc::clone(&client_dir);
                async move { serve_client::serve(uri, client_dir).await }
            }
        });

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
    // Reap every owned codex app-server sidecar (SIGKILL + `/proc` ownership sweep) so a
    // freshcodex T2 run leaves no orphaned app-server.
    fresh_codex_state.shutdown().await;
    // Reap every owned claude Node sidecar (SIGTERM → it kills its own claude CLI via the
    // SDK abort → SIGKILL straggler + `/proc` ownership sweep) so a freshclaude T2 run
    // leaves no orphaned sidecar or claude CLI grandchild.
    fresh_claude_state.shutdown().await;
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

/// Build the `{ platform, availableClis, hostName, featureFlags }` payload the
/// SPA reads on boot (mirrors `server/platform-router.ts`). `platform` is the
/// real `/proc/version`-derived string (`detect_platform_proc`); `availableClis`
/// is the extension-driven `which`/`where.exe` detection result (Follow-up 3.19,
/// so the PanePicker surfaces the real coding-CLI agents), and `featureFlags`
/// defaults off.
fn build_platform_payload(available_clis: serde_json::Value) -> serde_json::Value {
    let platform = detect_platform_proc(host_os_live(), read_proc_version().as_deref());
    serde_json::json!({
        "platform": platform,
        "availableClis": available_clis,
        "hostName": read_host_name(),
        "featureFlags": { "kilroy": false, "aiEnabled": false },
    })
}

/// The OS hostname (mirrors `detectHostName`). `/proc/sys/kernel/hostname` →
/// `$HOSTNAME` → `"localhost"`.
fn read_host_name() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "localhost".to_string())
}

/// Resolve the built `dist/client` directory to serve the SPA from. Mirrors the
/// original's `path.join(distRoot, 'client')`, with an explicit override for the
/// oracle harness:
/// * `FRESHELL_CLIENT_DIR` (explicit) →
/// * `<worktree>/dist/client` (compile-time fallback, for a local run) →
/// * `./dist/client` (cwd-relative last resort).
fn resolve_client_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("FRESHELL_CLIENT_DIR") {
        return PathBuf::from(dir);
    }
    let compiled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist/client");
    if compiled.exists() {
        return compiled;
    }
    PathBuf::from("dist/client")
}
