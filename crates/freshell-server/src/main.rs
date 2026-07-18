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
mod checkpoints;
mod extensions;
mod files;
mod logging;
mod network;
mod proxy;
mod screenshots;
mod serve_client;
mod session_directory;
mod session_metadata;
mod sessions;
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
use freshell_platform::detect::{
    detect_platform_proc, host_os_live, is_wsl_proc, read_proc_version,
};
use freshell_ws::WsState;
use uuid::Uuid;

use crate::boot::BootState;

/// App version reported by `GET /api/version` (mirrors `package.json` `version`).
/// Overridable via `FRESHELL_APP_VERSION` for parity when a run needs it.
const APP_VERSION: &str = "0.7.0";

/// Load `.env` from `dir` into the process environment — legacy parity for the
/// original's `import 'dotenv/config'` (`server/index.ts:2-3`), which resolves
/// against `process.cwd()` before anything else in the module reads `process.env`
/// (including its own `AUTH_TOKEN` read). Node `dotenv`'s default semantics
/// (and `dotenvy`'s, mirrored here): a process env var that is ALREADY set is
/// never overridden by the file. A missing `.env` file is a silent no-op —
/// `dotenvy::from_path` returns an `Io(NotFound)` error we deliberately ignore,
/// matching `dotenv/config`'s own silent-missing-file behavior.
fn load_dotenv_from(dir: &Path) {
    let _ = dotenvy::from_path(dir.join(".env"));
}

#[tokio::main]
async fn main() -> ExitCode {
    // Legacy parity: `import 'dotenv/config'` (`server/index.ts:2-3`) loads
    // `.env` from cwd before the module reads ANY process env — including the
    // AUTH_TOKEN check immediately below. A cwd we can't resolve, or a cwd with
    // no `.env`, is a silent no-op either way.
    if let Ok(cwd) = std::env::current_dir() {
        load_dotenv_from(&cwd);
    }

    // AUTH_TOKEN is mandatory — refuse to start without it (matches the original).
    let auth_token = match std::env::var("AUTH_TOKEN") {
        Ok(token) => match validate_auth_token(&token) {
            Ok(()) => Arc::new(token),
            Err(reason) => {
                eprintln!("{reason}");
                return ExitCode::FAILURE;
            }
        },
        Err(_) => {
            eprintln!("AUTH_TOKEN is required. Refusing to start without authentication.");
            return ExitCode::FAILURE;
        }
    };

    let port = resolve_port();
    let bind_host = resolve_bind_host();
    let home = resolve_home();

    // DIAG-01/DIAG-03: structured JSONL logging to
    // `<home>/.freshell/logs/rust-server.jsonl`, redacted from the first
    // byte (the live AUTH_TOKEN is the ONE secret this process itself
    // knows verbatim). A failure here (e.g. an unwritable log dir) must
    // never prevent boot -- the pre-existing stderr "listening on" line
    // below still gets the operator to a running server either way.
    let logging_config = logging::resolve_config(home.as_deref(), auth_token.as_str().to_string());
    if let Err(err) = logging::init(logging_config) {
        eprintln!("freshell-server: structured logging disabled: {err}");
    }

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
    let app_version =
        Arc::new(std::env::var("FRESHELL_APP_VERSION").unwrap_or_else(|_| APP_VERSION.to_string()));

    // The server-start timestamp, captured once here as an ISO-8601 string
    // (millisecond precision + `Z`, matching JS `Date.toISOString()` in
    // `server/health-router.ts`). Surfaced as health `startedAt`.
    let started_at =
        Arc::new(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));

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
    let known_providers: Vec<String> =
        extensions::ExtensionRegistry::scan(&extensions::resolve_extension_dirs(home.as_deref()))
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

    // The fresh-agent REST surface (opencode slice): shares the auth token + the
    // broadcast bus so its create/send broadcasts reach every WS client. Constructed
    // here (before `ws_state`) so the WS freshopencode slice below can wrap the SAME
    // instance -- one `opencode serve` sidecar shared by both surfaces (Batch D PR-2).
    let fresh_agent_state =
        FreshAgentState::new(Arc::clone(&auth_token), Arc::clone(&broadcast_tx));
    // The freshopencode WS fresh-agent slice: the post-handshake loop dispatches
    // `freshAgent.create`/`send`/`kill`/`interrupt` (opencode) here.
    let fresh_opencode_state =
        freshell_freshagent::FreshOpencodeState::new(fresh_agent_state.clone());

    // The shared, connection-independent terminal registry: terminals are owned by
    // `terminalId` here (not by the socket that created them), so a second/reconnected
    // socket re-attaches to a running PTY and replays its scrollback. This is what
    // makes the multi-client / reconnection / hot-across-reload flows work.
    // Cloned (cheap Arc) into the files REST surface too, whose `candidate-dirs`
    // sources the running terminals' cwds for the DirectoryPicker.
    let registry = freshell_terminal::TerminalRegistry::new();
    // TERM-11 fix: honor `settings.safety.autoKillIdleMinutes` at boot (the
    // Rust registry previously never read it at all, so a config that raised
    // or lowered it from the default had no effect). See
    // `freshell_ws::spawn_idle_monitor` for the periodic sweep this feeds.
    registry.set_auto_kill_idle_minutes(settings.safety.auto_kill_idle_minutes);
    freshell_ws::spawn_idle_monitor(registry.clone(), std::time::Duration::from_secs(30));
    // TERM-13 fix: honor `settings.terminal.scrollback` at boot (the Rust
    // registry previously used a fixed 8MiB replay-log cap for every
    // terminal, ignoring the configured value entirely).
    registry.set_scrollback_max_bytes(freshell_terminal::compute_scrollback_max_bytes(
        settings.terminal.scrollback,
    ));
    // Fix Spec: Session Naming Cluster -- the shared terminal-identity registry
    // (`freshell_ws::identity`, the port-side closure of
    // `TerminalMetadataService`'s provider/sessionId association slice). Written
    // by the WS terminal create/kill/exit paths (`ws_state`, below); read by the
    // REST rename cascades (`terminals_state`/`sessions::SessionsState`) and the
    // session-directory live-terminal join (`session_directory_state`).
    let terminal_identity = freshell_ws::identity::TerminalIdentityRegistry::new();
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
    // { mode: <cli> }` against (claude/codex/opencode → the real CLI launch). Full
    // manifest compilation per `server/index.ts:231-255` (arg templates + env),
    // spec `port/machine/specs/cli-argv-fidelity.md` §3.1.
    let cli_commands = Arc::new(extension_registry.cli_command_specs());

    // Graceful-shutdown notify: on SIGTERM/SIGINT every live WS connection closes
    // with `4009 "Server shutting down"` (ws-handler.ts:3843 parity).
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    // ONE handler-scoped `terminals.changed` revision counter, shared by the WS
    // terminal lifecycle paths (create/kill, ws-handler.ts:2553/2570/2988) and the
    // REST `/api/terminals` PATCH/DELETE broadcasts — the original keeps a single
    // `terminalsRevision` on the WsHandler that both surfaces stamp.
    let terminals_revision = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let ws_state = WsState {
        identity: terminal_identity.clone(),
        auth_token: Arc::clone(&auth_token),
        // Shared (not moved) so `GET /api/health` reports the SAME `instanceId`.
        server_instance_id: Arc::clone(&server_instance_id),
        boot_id,
        settings: Arc::clone(&settings),
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: fresh_codex_state.clone(),
        fresh_claude: fresh_claude_state.clone(),
        fresh_opencode: fresh_opencode_state.clone(),
        registry: registry.clone(),
        tabs: tabs.clone(),
        screenshots: screenshots.clone(),
        terminals_revision: Arc::clone(&terminals_revision),
        cli_commands: Arc::clone(&cli_commands),
        shutdown: Arc::clone(&shutdown_notify),
        ping_interval_ms: resolve_ping_interval_ms(),
        allowed_origins: Arc::new(resolve_allowed_origins()),
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
        platform: Arc::new(build_platform_payload(
            available_clis,
            &freshell_platform::RealEnv,
        )),
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
    //
    // Batch B: `session_directory` no longer re-walks + re-parses every
    // transcript on every request -- it reads a cached, TTL-refreshed
    // `SessionIndex`. Batch C adds `CodexSource` (file-based, same shape as
    // `ClaudeSource`) and `OpencodeSource` (direct-listed from
    // `opencode.db`) alongside claude. `None` home -> no index -> the prior
    // empty-page behavior.
    //
    // FRESHELL_HOME root-alignment fix: provider transcript sources must
    // resolve against the REAL home, never the (possibly `FRESHELL_HOME`-
    // overridden) isolated config root `home` above -- see
    // `session_directory::provider_home` for the full rationale.
    //
    // Fourth source: `AmplifierSource` (`crates/freshell-sessions/src/amplifier.rs`,
    // a faithful port of `server/coding-cli/providers/amplifier.ts`'s
    // discovery/parse -- file-based, same shape as `ClaudeSource`/`CodexSource`).
    // `amplifier_home` lives in that module (not `session_directory.rs`, whose
    // internals are out of scope for this change) but resolves the SAME
    // `AMPLIFIER_HOME` env / `<home>/.amplifier` default convention
    // `claude_home`/`codex_home` use, against the same `provider_home()` root.
    let session_index = session_directory::provider_home().as_ref().map(|h| {
        Arc::new(freshell_sessions::directory_index::SessionIndex::new(vec![
            Arc::new(freshell_sessions::directory_index::ClaudeSource::new(
                session_directory::claude_home(h),
            )) as Arc<dyn freshell_sessions::directory_index::SessionSource>,
            Arc::new(freshell_sessions::directory_index::CodexSource::new(
                session_directory::codex_home(h),
            )) as Arc<dyn freshell_sessions::directory_index::SessionSource>,
            Arc::new(freshell_sessions::directory_index::OpencodeSource::new(
                freshell_sessions::parse::default_opencode_data_home(),
            )) as Arc<dyn freshell_sessions::directory_index::SessionSource>,
            Arc::new(freshell_sessions::amplifier::AmplifierSource::new(
                freshell_sessions::amplifier::amplifier_home(h),
            )) as Arc<dyn freshell_sessions::directory_index::SessionSource>,
        ]))
    });
    // Warm the cache in the background so the first real request never pays
    // the cold full-sweep cost. The scan itself runs in `spawn_blocking`
    // (inside `SessionIndex::snapshot`), so this never delays serving other
    // requests while it's in flight.
    if let Some(index) = &session_index {
        let index = Arc::clone(index);
        // DIAG-01: log the initial warm sweep's count + duration (an
        // equivalent call to `index.warm()`'s own body -- `snapshot()` is
        // what `warm()` calls internally -- but keeping the return value
        // here lets this main.rs-scoped call site report a real count
        // instead of discarding it).
        tokio::spawn(async move {
            let start = std::time::Instant::now();
            let items = index.snapshot().await;
            tracing::info!(
                event = "session_index_warm",
                count = items.len(),
                duration_ms = start.elapsed().as_millis() as u64,
                "session index warm sweep complete"
            );
        });
    }
    let session_directory_state = session_directory::SessionDirectoryState {
        auth_token: Arc::clone(&auth_token),
        settings: settings_store.clone(),
        session_index,
        identity: terminal_identity.clone(),
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
        terminals_revision: Arc::clone(&terminals_revision),
        identity: terminal_identity.clone(),
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
    // The fresh-agent thread-snapshot REST endpoint (Batch D PR-5): `GET
    // /api/fresh-agent/threads/:sessionType/:provider/:threadId`, the SPA's
    // `commitSnapshot` read path (`src/lib/api.ts:312` `getFreshAgentThreadSnapshot`).
    // Shares the already-constructed codex/opencode slices -- no new session state.
    let snapshot_state = freshell_freshagent::SnapshotState::new(
        Arc::clone(&auth_token),
        fresh_codex_state.clone(),
        fresh_agent_state.clone(),
    );

    // `POST /api/session-metadata` (`server/sessions-router.ts:220-244` +
    // `session-metadata-store.ts`): persists sidebar/fresh-agent `sessionType` tags to
    // `<home>/.freshell/session-metadata.json`. Same isolated-home directory the settings
    // store resolves (`settings_store.rs:246`), so a real deployment's existing
    // `session-metadata.json` is discovered exactly like the legacy server discovers it.
    let session_metadata_dir = home
        .as_deref()
        .map(|h| h.join(".freshell"))
        .unwrap_or_else(|| PathBuf::from(".freshell"));
    let session_metadata_store = session_metadata::SessionMetadataStore::new(session_metadata_dir);
    let session_metadata_state = session_metadata::SessionMetadataApiState {
        auth_token: Arc::clone(&auth_token),
        store: session_metadata_store,
    };

    // `POST /api/fresh-agent/checkpoints` (`fresh-agent-extras-router.ts:346-368`):
    // the fire-and-forget pre-turn shadow-git snapshot the SPA takes on every
    // fresh-agent send. `home` mirrors `os.homedir()` (checkpoints live under
    // `<home>/.freshell/checkpoints/`, same isolated home the session-metadata
    // store above resolves) -- a `None` home (no `FRESHELL_HOME`/`HOME`) falls
    // back to the cwd-relative `.` the other home-relative state above uses.
    let checkpoints_state = checkpoints::CheckpointsApiState {
        auth_token: Arc::clone(&auth_token),
        home: Arc::new(home.clone().unwrap_or_else(|| PathBuf::from("."))),
    };

    let app = freshell_api::router(api_state)
        .merge(freshell_ws::router(ws_state))
        .merge(freshell_freshagent::router(fresh_agent_state.clone()))
        .merge(freshell_freshagent::snapshot::router(snapshot_state))
        .merge(session_metadata::router(session_metadata_state))
        .merge(checkpoints::router(checkpoints_state))
        // R1/R2/R3/R4: the ONE `/api/settings` router (GET+PATCH+PUT), backed by
        // the live `settings_store` \u2014 replaces the old split between this boot
        // module's frozen GET and the freshcodex slice's disconnected PATCH.
        .merge(settings_store::router(
            settings_store::SettingsRouterState {
                store: settings_store.clone(),
                auth_token: Arc::clone(&auth_token),
                broadcast_tx: Arc::clone(&broadcast_tx),
                fresh_codex: fresh_codex_state.clone(),
            },
        ))
        .merge(boot::router(boot_state))
        .merge(network::router(network_state))
        .merge(session_directory::router(session_directory_state))
        .merge(sessions::router(sessions::SessionsState {
            auth_token: Arc::clone(&auth_token),
            settings: settings_store.clone(),
            identity: terminal_identity.clone(),
            registry: registry.clone(),
            broadcast_tx: Arc::clone(&broadcast_tx),
            terminals_revision: Arc::clone(&terminals_revision),
        }))
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
        .layer(axum::middleware::map_response(ensure_json_charset))
        // DIAG-01: the outermost layer, so it wraps every route INCLUDING the
        // fallback (unmatched-path 404/401, the retained SPA, and the `/ws`
        // upgrade) -- one `http_request` JSONL event per response, carrying a
        // fresh `request_id`, the sanitized route, method, status, and
        // duration. See `logging.rs` for exactly what this does and does not
        // cover (WS post-upgrade lifecycle is out of scope for this layer).
        .layer(axum::middleware::from_fn(
            logging::request_logging_middleware,
        ));

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

    // Serve with graceful shutdown on SIGTERM/SIGINT so every owned child (PTY
    // terminals, the Codex/claude/opencode sidecars) is reaped — no orphans.
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(Arc::clone(&shutdown_notify)))
        .await;
    // SAFE-11/TERM-22: reap every owned child tree before exit. Legacy parity
    // (`server/index.ts:981-1049`'s `shutdown()`): after the HTTP/WS surface is
    // drained, `joinCodexShutdownOwners` reaps `registry.shutdownGracefully()`
    // (terminals) and the Codex/opencode sidecars together, then
    // `codingCliSessionManager.shutdown()` covers any remaining coding-CLI
    // session. This port's equivalents run in the same spot:
    //   * `registry.kill_all()` — every tracked PTY terminal (`mode:'shell'`
    //     and any other registry-tracked terminal, e.g. a plain `sleep 300`
    //     shell) — the gap this fix closes; nothing previously killed these.
    //   * `fresh_agent_state.shutdown()` — the shared opencode `serve`
    //     sidecar. Legacy parity note: the original DOES tear this down on a
    //     general server shutdown (`codexFreshAgentRuntime.shutdown()` in
    //     `server/index.ts:330-332` calls `opencodeFreshAgentAdapter.shutdown`,
    //     which reaches `OpencodeServeManager.shutdown()`,
    //     `server/fresh-agent/adapters/opencode/serve-manager.ts:573-591`) — it
    //     is NOT deliberately left running across a general restart, so this
    //     port matches that (already implemented before this fix).
    //   * `fresh_codex_state.shutdown()` / `fresh_claude_state.shutdown()` —
    //     the Codex app-server and claude Node sidecars (already implemented).
    registry.kill_all();
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

/// SAFE-11: the hard ceiling on the whole shutdown sequence — WS drain +
/// terminal/sidecar reaping — measured from the moment a shutdown signal
/// arrives. "Use the full grace period" (not less), but never hang forever:
/// [`shutdown_signal`] arms a watchdog at this exact instant that force-exits
/// nonzero if the process is still alive once it elapses.
const SHUTDOWN_HARD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Resolve once a shutdown signal arrives (SIGTERM from the oracle harness's
/// `stop()`, or Ctrl-C). Drives `axum`'s graceful shutdown so every owned
/// child (PTY terminals, the Codex/claude/opencode sidecars) is reaped before
/// exit.
async fn shutdown_signal(notify_ws: Arc<tokio::sync::Notify>) {
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

    // SAFE-11 fail-safe watchdog: arm the hard timeout THE INSTANT the signal
    // arrives (not at process boot — a long-lived server must never carry a
    // ticking bomb while just serving requests). If the graceful sequence
    // below (WS drain, then `registry.kill_all()` + every fresh-agent
    // sidecar's `shutdown()`) hasn't exited the process by the time this
    // fires, something hung — log it and force-exit nonzero rather than
    // leave the operator's terminal blocked forever.
    tokio::spawn(async {
        tokio::time::sleep(SHUTDOWN_HARD_TIMEOUT).await;
        eprintln!(
            "freshell-server: graceful shutdown exceeded {SHUTDOWN_HARD_TIMEOUT:?}; force-exiting"
        );
        std::process::exit(1);
    });

    // Close every live WS connection with `4009 "Server shutting down"`
    // (ws-handler.ts:3843 parity) and give the close frames a beat to flush
    // before axum tears the listener down.
    notify_ws.notify_waiters();
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
}

/// S1 fix: rewrite a bare `application/json` response Content-Type to the
/// original's exact `application/json; charset=utf-8` (Express's `res.json`
/// always emits the charset suffix; axum's `Json` extractor does not). Applied
/// as a global response-mapping layer so no individual handler has to remember
/// it. Idempotent: a response that already carries a charset (or isn't JSON at
/// all, e.g. the SPA/static responses) passes through unchanged.
async fn ensure_json_charset(mut response: axum::response::Response) -> axum::response::Response {
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

/// Default/weak `AUTH_TOKEN` values the original refuses to start with
/// (`server/auth.ts` `DEFAULT_BAD_TOKENS`, exact set, case-insensitive).
const DEFAULT_BAD_TOKENS: [&str; 4] = ["changeme", "default", "password", "token"];

/// SAFE-01 startup hardening (mirrors `server/auth.ts#validateStartupSecurity`,
/// called from the `AUTH_TOKEN` env read above). Checked in the original's
/// order — empty, then too short, then default/weak — with one deliberate
/// addition: a whitespace-only token is rejected even if it is >= 16
/// characters. The original's own check (`!token`) is JS-falsy-only, so
/// `"                "` (16 spaces) would pass it; a whitespace secret is
/// never an effective one, so this crate closes that gap rather than port it.
fn validate_auth_token(token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err(
            "AUTH_TOKEN is required. Refusing to start without authentication.".to_string(),
        );
    }
    if token.len() < 16 {
        return Err("AUTH_TOKEN is too short. Use at least 16 characters.".to_string());
    }
    if DEFAULT_BAD_TOKENS.contains(&token.to_lowercase().as_str()) {
        return Err(
            "AUTH_TOKEN appears to be a default/weak value. Refusing to start.".to_string(),
        );
    }
    Ok(())
}

/// Resolve the port to bind. Mirrors `server/index.ts`: `PORT` env or 3001.
fn resolve_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3001)
}

/// Resolve the WS keepalive ping interval, milliseconds. Mirrors
/// `ws-handler.ts:224`: `Number(process.env.PING_INTERVAL_MS || 30_000)`.
fn resolve_ping_interval_ms() -> u64 {
    std::env::var("PING_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000)
}

/// SAFE-03: resolve the WS Origin allow-list from process env, mirroring
/// `server/auth.ts#parseAllowedOrigins` (`ALLOWED_ORIGINS`) plus
/// `server/network-manager.ts`'s user-facing `EXTRA_ALLOWED_ORIGINS` knob
/// (see [`freshell_ws::origin`]).
fn resolve_allowed_origins() -> Vec<String> {
    freshell_ws::origin::resolve_allowed_origins(
        std::env::var("ALLOWED_ORIGINS").ok().as_deref(),
        std::env::var("EXTRA_ALLOWED_ORIGINS").ok().as_deref(),
    )
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
/// so the PanePicker surfaces the real coding-CLI agents); `featureFlags.kilroy`
/// defaults off (no `KILROY_ENABLED` wiring yet); `featureFlags.aiEnabled`
/// mirrors `AI_CONFIG.enabled()` (see [`ai_enabled`]).
fn build_platform_payload(
    available_clis: serde_json::Value,
    env: &dyn freshell_platform::Env,
) -> serde_json::Value {
    let platform = detect_platform_proc(host_os_live(), read_proc_version().as_deref());
    serde_json::json!({
        "platform": platform,
        "availableClis": available_clis,
        "hostName": read_host_name(),
        "featureFlags": { "kilroy": false, "aiEnabled": ai_enabled(env) },
    })
}

/// `AI_CONFIG.enabled()` (`server/ai-prompts.ts:12-15`):
/// `enabled: () => Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY)`. JS
/// `Boolean(str | undefined)` is true iff the var is set AND non-empty, which
/// is exactly [`freshell_platform::Env::truthy`]'s semantics.
fn ai_enabled(env: &dyn freshell_platform::Env) -> bool {
    env.truthy("GOOGLE_GENERATIVE_AI_API_KEY")
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

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_platform::MapEnv;

    // `AI_CONFIG.enabled()` (`server/ai-prompts.ts:12-15`):
    // `enabled: () => Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY)`.
    // These use an injected `MapEnv` (not real process env), so they need no
    // env-isolation guard: each test constructs its own independent view.

    #[test]
    fn ai_enabled_true_when_key_set_non_empty() {
        let env = MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-live-abc123");
        assert!(ai_enabled(&env));
    }

    #[test]
    fn ai_enabled_false_when_key_unset() {
        let env = MapEnv::new();
        assert!(!ai_enabled(&env));
    }

    #[test]
    fn ai_enabled_false_when_key_set_empty() {
        // JS `Boolean("")` is `false` — an explicitly-empty var is still falsy.
        let env = MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "");
        assert!(!ai_enabled(&env));
    }

    #[test]
    fn platform_payload_feature_flags_shape_matches_legacy() {
        // `server/platform-router.ts#detectFeatureFlags`: `{ kilroy, aiEnabled }`,
        // camelCase, no extra fields — mirrored 1:1 in the Rust payload.
        let env = MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-live-abc123");
        let payload = build_platform_payload(serde_json::json!({}), &env);
        assert_eq!(
            payload["featureFlags"],
            serde_json::json!({ "kilroy": false, "aiEnabled": true })
        );
    }

    #[test]
    fn platform_payload_ai_enabled_false_without_key() {
        let env = MapEnv::new();
        let payload = build_platform_payload(serde_json::json!({}), &env);
        assert_eq!(
            payload["featureFlags"],
            serde_json::json!({ "kilroy": false, "aiEnabled": false })
        );
    }

    // `load_dotenv_from` (legacy parity: `import 'dotenv/config'`,
    // `server/index.ts:2-3`). Each test uses its own temp dir + a uniquely-named
    // sentinel var, so parallel test execution can't collide.

    #[test]
    fn load_dotenv_from_sets_var_absent_from_process_env() {
        let dir = std::env::temp_dir().join("freshell-dotenv-test-unset");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".env"),
            "FRESHELL_TASK7_TEST_VAR_UNSET=from-dotenv\n",
        )
        .unwrap();
        std::env::remove_var("FRESHELL_TASK7_TEST_VAR_UNSET");

        load_dotenv_from(&dir);

        assert_eq!(
            std::env::var("FRESHELL_TASK7_TEST_VAR_UNSET").as_deref(),
            Ok("from-dotenv")
        );

        std::env::remove_var("FRESHELL_TASK7_TEST_VAR_UNSET");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_dotenv_from_never_overrides_existing_process_env_var() {
        let dir = std::env::temp_dir().join("freshell-dotenv-test-set");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".env"),
            "FRESHELL_TASK7_TEST_VAR_SET=from-dotenv\n",
        )
        .unwrap();
        std::env::set_var("FRESHELL_TASK7_TEST_VAR_SET", "already-set");

        load_dotenv_from(&dir);

        assert_eq!(
            std::env::var("FRESHELL_TASK7_TEST_VAR_SET").as_deref(),
            Ok("already-set")
        );

        std::env::remove_var("FRESHELL_TASK7_TEST_VAR_SET");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // SAFE-01: startup token hardening (`server/auth.ts#validateStartupSecurity`).
    // Order mirrors legacy: empty/whitespace -> too short (<16) -> default/weak
    // value (case-insensitive exact match). Whitespace-only is beyond-legacy
    // hardening (the original's `!token` check is JS-falsy-only, so a
    // whitespace string of length >= 16 would pass it; we reject it here
    // because a whitespace token is never a deliberate, effective secret).

    #[test]
    fn rejects_empty_token() {
        assert!(validate_auth_token("").is_err());
    }

    #[test]
    fn rejects_whitespace_only_token() {
        // 20 spaces: long enough to pass the length check, still rejected.
        assert!(validate_auth_token("                    ").is_err());
    }

    #[test]
    fn rejects_token_shorter_than_16_chars() {
        assert!(validate_auth_token("short123").is_err());
    }

    #[test]
    fn rejects_default_weak_tokens_case_insensitive() {
        for weak in [
            "changeme", "CHANGEME", "ChangeMe", "default", "password", "TOKEN",
        ] {
            assert!(
                validate_auth_token(weak).is_err(),
                "expected {weak:?} to be rejected as a weak/default token"
            );
        }
    }

    #[test]
    fn accepts_strong_token() {
        assert!(validate_auth_token("s3cr3t-token-abcdef").is_ok());
    }

    #[test]
    fn load_dotenv_from_missing_file_is_noop() {
        let dir = std::env::temp_dir().join("freshell-dotenv-test-missing");
        // Deliberately no `.env` written into this dir.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::remove_file(dir.join(".env")).ok();

        // Must not panic.
        load_dotenv_from(&dir);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
