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
mod settings_store;
mod terminals;
mod updater;

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use freshell_api::ApiState;
use freshell_freshagent::FreshAgentState;
use freshell_platform::detect::{detect_platform_proc, host_os_live, is_wsl_proc, read_proc_version};
use freshell_ws::WsState;
use uuid::Uuid;

use crate::boot::BootState;

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
    // `server_instance_id` is shared (Arc::clone) into BOTH the WS handshake
    // (`ready.serverInstanceId`) AND `GET /api/health` (`instanceId`), so the id an
    // Electron discovery candidate records matches the handshake it later opens.
    let server_instance_id = Arc::new(format!("srv-{}", Uuid::new_v4()));
    let boot_id = Arc::new(format!("boot-{}", Uuid::new_v4()));

    // The app version string, resolved ONCE and shared (Arc::clone) into BOTH
    // `GET /api/version` (`currentVersion`) and `GET /api/health` (`version`), so
    // the two endpoints can never disagree. Overridable via `FRESHELL_APP_VERSION`.
    let app_version = Arc::new(
        std::env::var("FRESHELL_APP_VERSION").unwrap_or_else(|_| APP_VERSION.to_string()),
    );

    // The server-start timestamp, captured once here as an ISO-8601 string
    // (millisecond precision + `Z`, matching JS `Date.toISOString()` in
    // `server/health-router.ts`). Surfaced as health `startedAt`.
    let started_at = Arc::new(
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );

    // R2/R3/R4 root-cause fix: a single LIVE settings store, not a boot-time
    // snapshot. `allCliNames` (`server/index.ts:267-269`) is discovered here via
    // the SAME cwd/home-relative dirs the original scans (`userExtDir`,
    // `localExtDir`, `builtinExtDir` — `server/index.ts:225-227`; NO compiled-in
    // fallback, see `resolve_builtin_extensions_dir`). `SettingsStore::load`
    // runs the original's startup knownProviders migration against it
    // (`server/index.ts:271-299`): seed-when-missing, append-new + auto-enable
    // otherwise — pinned live 2026-07-12 (cwd-neutral fresh boot ⇒ `[]`;
    // cwd=repo fresh boot ⇒ 5 names; persisted `[]` + cwd=repo reboot ⇒
    // knownProviders grows AND enabledProviders auto-enables the new names).
    // The same discovered set is the PATCH validation allowlist
    // (`validCliProviders: allCliNames`, `server/index.ts:585`).
    let known_providers: Vec<String> = extensions::ExtensionRegistry::scan(
        &extensions::resolve_extension_dirs(home.as_deref()),
    )
    .discovered_cli_names();
    let settings_store = settings_store::SettingsStore::load(home.as_deref(), known_providers);
    let settings = Arc::new(settings_store.get().await);

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

    // Follow-up 3.19: discover the CLI extensions (bundled `extensions/` + user/local
    // dirs) once. Feeds THREE consumers: the WS terminal spawner's coding-CLI command
    // resolution (`cli_commands`, below), `availableClis` (platform payload), and the
    // client registry (`GET /api/extensions`).
    let extension_registry =
        extensions::ExtensionRegistry::scan(&extensions::resolve_extension_dirs(home.as_deref()));
    // The coding-CLI command specs the WS terminal handler resolves `terminal.create
    // { mode: <cli> }` against (claude/codex/opencode → the real CLI launch).
    let cli_commands = Arc::new(
        extension_registry
            .cli_detection_specs()
            .into_iter()
            .map(|s| freshell_platform::CliCommandSpec {
                name: s.name,
                env_var: s.env_var,
                default_cmd: s.default_cmd,
            })
            .collect::<Vec<_>>(),
    );

    let ws_state = WsState {
        auth_token: Arc::clone(&auth_token),
        // Shared (not moved) so `GET /api/health` reports the SAME `instanceId`.
        server_instance_id: Arc::clone(&server_instance_id),
        boot_id,
        settings: Arc::clone(&settings),
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: fresh_codex_state.clone(),
        fresh_claude: fresh_claude_state.clone(),
        registry: registry.clone(),
        tabs: tabs.clone(),
        screenshots: screenshots.clone(),
        cli_commands: Arc::clone(&cli_commands),
    };
    let api_state = ApiState {
        auth_token: Arc::clone(&auth_token),
        ready: true,
        // Same version as `GET /api/version` and same instance id as the WS
        // `ready` handshake, so `GET /api/health` (which the legacy Electron
        // launcher's discovery probe consumes) is consistent with both.
        version: Arc::clone(&app_version),
        instance_id: Arc::clone(&server_instance_id),
        started_at: Arc::clone(&started_at),
    };
    // The fresh-agent REST surface (opencode slice): shares the auth token + the
    // broadcast bus so its create/send broadcasts reach every WS client.
    let fresh_agent_state = FreshAgentState::new(Arc::clone(&auth_token), Arc::clone(&broadcast_tx));

    // Detect which coding-CLI agents are on PATH (so the PanePicker surfaces the real
    // claude/codex/opencode agents, was `{}`) and serialize the client registry for
    // `GET /api/extensions`, reusing the `extension_registry` scanned above.
    let available_clis =
        extensions::detect_available_clis_live(&extension_registry.cli_detection_specs());
    let extensions_registry = Arc::new(extension_registry.to_client_registry());

    // The boot REST surface the RETAINED React SPA fetches on first paint
    // (bootstrap/platform/version/settings/session-directory/terminals/network),
    // and the resolved `dist/client` dir the SPA is served from.
    let boot_state = BootState {
        auth_token: Arc::clone(&auth_token),
        settings: settings_store.clone(),
        platform: Arc::new(build_platform_payload(available_clis)),
        // The SAME resolved version `GET /api/health` reports (shared above), so
        // `/api/version` `currentVersion` and health `version` never diverge.
        app_version: Arc::clone(&app_version),
        tabs: tabs.clone(),
        extensions: Arc::clone(&extensions_registry),
        // R5: one shared live GitHub update-checker (its own internal cache).
        update_checker: updater::UpdateChecker::new(),
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
        settings: settings_store.clone(),
        registry: registry.clone(),
    };

    // The `/api/terminals` directory surface (GET list/page + PATCH/DELETE
    // overrides): reads the SAME registry the WS terminal path owns, patches
    // `config.terminalOverrides` through the live settings store, and broadcasts
    // `terminals.changed` on the shared bus.
    let terminals_state = terminals::TerminalsState {
        auth_token: Arc::clone(&auth_token),
        settings: settings_store.clone(),
        registry: registry.clone(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
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
    // (or 401, matching the original's auth-first middleware ordering \u2014 R12)
    // for any unmatched `/api/*` (never the HTML shell), mirroring the original ordering.
    let fallback_auth_token = Arc::clone(&auth_token);
    let app = freshell_api::router(api_state)
        .merge(freshell_ws::router(ws_state))
        .merge(freshell_freshagent::router(fresh_agent_state.clone()))
        // R1/R2/R3/R4: the ONE `/api/settings` router (GET+PATCH+PUT), backed by
        // the live `settings_store` \u2014 replaces the old split between this boot
        // module's frozen GET and the freshcodex slice's disconnected PATCH.
        .merge(settings_store::router(settings_store::SettingsRouterState {
            store: settings_store.clone(),
            auth_token: Arc::clone(&auth_token),
            broadcast_tx: Arc::clone(&broadcast_tx),
            fresh_codex: fresh_codex_state.clone(),
        }))
        .merge(boot::router(boot_state))
        .merge(network::router(network_state))
        .merge(session_directory::router(session_directory_state))
        .merge(files::router(files_state))
        .merge(terminals::router(terminals_state))
        .merge(proxy::router(proxy_state))
        .merge(screenshots::router(screenshots_state))
        .fallback({
            let client_dir = Arc::clone(&client_dir);
            move |uri: axum::http::Uri, headers: axum::http::HeaderMap| {
                let client_dir = Arc::clone(&client_dir);
                let auth_token = Arc::clone(&fallback_auth_token);
                async move { serve_client::serve(uri, headers, client_dir, auth_token).await }
            }
        })
        // S1: the original (Express `res.json`) always emits
        // `application/json; charset=utf-8`; axum's `Json` extractor emits bare
        // `application/json`. Normalize every plain-`application/json` response to
        // the original's exact charset suffix, globally, so no individual handler
        // has to remember it.
        .layer(axum::middleware::map_response(ensure_json_charset));

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

/// S1 fix: rewrite a bare `application/json` response Content-Type to the
/// original's exact `application/json; charset=utf-8` (Express's `res.json`
/// always emits the charset suffix; axum's `Json` extractor does not). Applied
/// as a global response-mapping layer so no individual handler has to remember
/// it. Idempotent: a response that already carries a charset (or isn't JSON at
/// all, e.g. the SPA/static responses) passes through unchanged.
async fn ensure_json_charset(
    mut response: axum::response::Response,
) -> axum::response::Response {
    use axum::http::{header, HeaderValue};
    let is_bare_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        == Some("application/json");
    if is_bare_json {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    response
}

/// Resolve the port to bind. Mirrors `server/index.ts`: `PORT` env or 3001.
fn resolve_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3001)
}

/// Resolve the bind host, faithfully to `server/get-network-host.ts`:
/// an explicit `FRESHELL_BIND_HOST` (`0.0.0.0`/`127.0.0.1`) wins; otherwise **on WSL
/// bind `0.0.0.0`** so the Windows host (browser / the legacy Electron app) can reach
/// the server across the WSL2 NAT boundary — "not remote access, basic WSL2
/// functionality" (get-network-host.ts:11-13,40-42); else fall back to `127.0.0.1`.
///
/// NOTE: the earlier loopback-only default diverged from the original (it left the
/// server unreachable from Windows). The oracle never caught it because the harness
/// always forces `FRESHELL_BIND_HOST=127.0.0.1` for test isolation — which this still
/// honors, so T0/T1/T2/T3 remain loopback and unaffected.
fn resolve_bind_host() -> String {
    let is_wsl = is_wsl_proc(read_proc_version().as_deref());
    freshell_platform::network::resolve_bind_host(
        &freshell_platform::RealEnv,
        is_wsl,
        // No config-file host override wired here; FRESHELL_BIND_HOST + the WSL
        // default + the `HOST` env fallback are what the standalone run needs.
        freshell_platform::network::BindHostConfig::Ok {
            raw_host: None,
            configured: false,
        },
    )
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
