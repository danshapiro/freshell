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
mod diag;
mod existence;
mod extensions;
mod files;
mod instance_id;
mod logging;
mod network;
mod proxy;
mod rate_limit;
mod screenshots;
mod serve_client;
mod session_directory;
mod session_metadata;
mod sessions;
mod settings;
mod settings_store;
mod tabs_snapshots;
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

    // Boot-scoped identifiers. `server_instance_id` is shared (Arc::clone) into
    // BOTH the WS handshake (`ready.serverInstanceId`) AND `GET /api/health`
    // (`instanceId`), so the id an Electron discovery candidate records matches
    // the handshake it later opens.
    //
    // CFG-07: `server_instance_id` is now PERSISTED per home (port of
    // `server/instance-id.ts#loadOrCreateServerInstanceId`) -- stable across
    // restarts of the SAME home, distinct across DIFFERENT homes. This is the
    // stable *installation* identity (tab-registry keying, session-locator
    // priority, live-terminal ownership -- see `instance_id.rs`'s module doc).
    // A `None` home (no `FRESHELL_HOME`/`HOME`, e.g. a headless/ephemeral run)
    // has nowhere to persist to, so it mints a fresh ephemeral id every boot --
    // matching legacy's `baseDir`-optional shape (`instance-id.ts`'s
    // `resolveInstanceIdPath` falls back to `getFreshellConfigDir()`, which
    // itself falls back to `os.homedir()`; a Rust `None` home has no such
    // fallback, so ephemeral-per-boot is the correct terminal case here).
    // A persistence FAILURE (e.g. an unwritable/corrupt home) also falls back
    // to an ephemeral id + a `warn` log rather than blocking boot -- mirrors
    // logging's own boot-tolerance (`logging::init`, above) and is a
    // documented degradation (A.9), not silent regeneration on the happy path.
    let server_instance_id = Arc::new(
        home.as_deref()
            .map(|h| instance_id::load_or_create(&h.join(".freshell")))
            .transpose()
            .unwrap_or_else(|err| {
                tracing::warn!(
                    error = %err,
                    "CFG-07: instance-id persistence failed; using an ephemeral id for this boot"
                );
                None
            })
            .unwrap_or_else(|| format!("srv-{}", Uuid::new_v4())),
    );
    // `boot_id` stays per-boot, regenerated every process start -- this is the
    // RESTART signal (A.10: never persist or rotate this). Restart detection is
    // owned by the terminal-inventory frame's `bootId` (an empty inventory +
    // changed `bootId` on reconnect means the server restarted), never by
    // `server_instance_id`.
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
    // DIAG-05: the SAME boot moment, captured as a monotonic `Instant` (not the
    // ISO-8601 string above) so `GET /api/server-info`'s `uptime` is immune to
    // wall-clock adjustments (matches legacy's `Date.now() - startedAt` intent
    // without legacy's wall-clock fragility).
    let boot_instant = std::time::Instant::now();

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
    // GAP1 (CFG-03 checklist follow-up): the boot-time `config.fallback`
    // notice, if the primary config needed to fall back at boot. `None` for
    // a healthy config or an ordinary fresh install. Threaded into
    // `WsState` below so every `/ws` connection's handshake includes it
    // (`freshell_ws::build_handshake`), mirroring the original's
    // per-connection `configFallback` (`server/index.ts:372-380`).
    let config_fallback = settings_store.config_fallback();

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

    // SESSION-09 fix-forward: mint the shared `sessions.changed` revision
    // counter BEFORE `fresh_agent_state` so it can be wired into both
    // producers -- see `FreshAgentState::with_shared_sessions_revision`'s doc
    // comment for the full rationale (previously `freshell-freshagent` kept
    // its OWN independent counter, which could mask a real change from one
    // producer behind a lower-or-equal revision from the other).
    let sessions_revision = Arc::new(std::sync::atomic::AtomicI64::new(0));
    // The fresh-agent REST surface (opencode slice): shares the auth token + the
    // broadcast bus so its create/send broadcasts reach every WS client. Constructed
    // here (before `ws_state`) so the WS freshopencode slice below can wrap the SAME
    // instance -- one `opencode serve` sidecar shared by both surfaces (Batch D PR-2).
    // `with_shared_sessions_revision` unifies its `sessions.changed` emission onto the
    // SAME sequence as `ws_state.sessions_revision` below (SESSION-09 fix-forward).
    let fresh_agent_state =
        FreshAgentState::new(Arc::clone(&auth_token), Arc::clone(&broadcast_tx))
            .with_shared_sessions_revision(Arc::clone(&sessions_revision));
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
    // Slice 1 (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md \u00a79 Risk 1): the
    // Agent-API's terminal-mode `POST /api/tabs` shares THIS SAME registry --
    // never a second one -- so an Agent-API-created shell terminal is a first-class
    // citizen of the one PTY registry the WS `terminal.create`/attach/kill paths use.
    let fresh_agent_state = fresh_agent_state.with_terminal_registry(registry.clone());
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
    //
    // Tabs registry now persists rolling snapshot generations under
    // `<home>/.freshell/tabs-snapshots/<deviceId>/` (last 5 per (device,
    // client) -- MAX_SNAPSHOT_GENERATIONS -- capped at 40 files per device
    // across all clients -- MAX_SNAPSHOT_FILES_PER_DEVICE) so a
    // device's tabs can be rebuilt after client-state loss (continuity trio,
    // docs/plans/2026-07-22-continuity-safety-trio.md).
    let tabs = match &home {
        Some(home) => freshell_ws::tabs::TabsRegistry::with_persist_dir(
            home.join(".freshell").join("tabs-snapshots"),
        ),
        None => freshell_ws::tabs::TabsRegistry::new(),
    };

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
    // SESSION-09: the SAME handler-scoped `sessions.changed` revision counter
    // minted above (and already wired into `fresh_agent_state` via
    // `with_shared_sessions_revision`), stamped ALSO by the periodic
    // session-directory sweep task (spawned below, once `session_index`
    // exists) -- see `freshell_ws::WsState::sessions_revision`'s doc comment
    // for the full parity rationale. Both producers now share this ONE
    // sequence (fix-forward: they previously used two independent counters).
    // Restore-across-restart fix (`docs/plans/2026-07-18-amplifier-restore-spec.md`):
    // the amplifier session locator, resolved against the SAME real-home root
    // `AmplifierSource` above uses (`session_directory::provider_home()`), so
    // an amplifier terminal's cwd is compared against the SAME
    // `AMPLIFIER_HOME`/`<home>/.amplifier` the CLI itself writes into. `None`
    // when the provider home can't be resolved (mirrors `session_index`'s own
    // `Option` convention) -- every `amplifier_association` entry point
    // no-ops in that case.
    let amplifier_locator = session_directory::provider_home().map(|h| {
        Arc::new(freshell_sessions::amplifier_locator::AmplifierLocator::new(
            freshell_sessions::amplifier::amplifier_home(&h),
        ))
    });
    // OpenCode terminal-pane restore fix
    // (`docs/plans/2026-07-18-opencode-terminal-restore-spec.md`): sibling
    // locator, resolved against the SAME `default_opencode_data_home()` root
    // the `OpencodeSource` (History sidebar) uses above, so an opencode
    // terminal's cwd is compared against the SAME `opencode.db` the CLI
    // itself writes into. Unconditionally `Some` (unlike `amplifier_locator`,
    // which depends on `session_directory::provider_home()`): opencode's data
    // home resolves independent of the isolated `FRESHELL_HOME` config root.
    let opencode_locator = Some(Arc::new(
        freshell_sessions::opencode_locator::OpencodeLocator::new(
            freshell_sessions::parse::default_opencode_data_home(),
        ),
    ));
    // Slice 3a (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md): wire the
    // SAME locators + coding-CLI command specs `ws_state` (below) gets into
    // `fresh_agent_state` too, so `POST /api/tabs` terminal-mode creates (a)
    // accept every mode the WS `terminal.create` path does and (b) arm a
    // fresh amplifier/opencode pane in the IDENTICAL locator instance the
    // periodic sweep (spawned below, against `ws_state`) already polls --
    // one shared instance, no second sweep loop.
    let fresh_agent_state = fresh_agent_state
        .with_cli_commands(Arc::clone(&cli_commands))
        .with_amplifier_locator(amplifier_locator.clone())
        .with_opencode_locator(opencode_locator.clone());
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

    let ws_state = WsState {
        identity: terminal_identity.clone(),
        amplifier_locator: amplifier_locator.clone(),
        opencode_locator: opencode_locator.clone(),
        // Reconciliation handshake disk-truth probe (design §5.1): backed by
        // the SAME shared session index the History surfaces read; the
        // no-index fallback (honest `Unknown` on known providers) when no
        // provider home resolves — mirrors `session_index`'s own `Option`
        // convention.
        session_existence: match &session_index {
            Some(index) => std::sync::Arc::new(existence::IndexExistenceProbe::new(
                std::sync::Arc::clone(index),
            )),
            None => std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        },
        auth_token: Arc::clone(&auth_token),
        // Shared (not moved) so `GET /api/health` reports the SAME `instanceId`.
        server_instance_id: Arc::clone(&server_instance_id),
        boot_id,
        settings: Arc::clone(&settings),
        config_fallback: config_fallback.clone(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: fresh_codex_state.clone(),
        fresh_claude: fresh_claude_state.clone(),
        fresh_opencode: fresh_opencode_state.clone(),
        registry: registry.clone(),
        tabs: tabs.clone(),
        screenshots: screenshots.clone(),
        terminals_revision: Arc::clone(&terminals_revision),
        sessions_revision: Arc::clone(&sessions_revision),
        cli_commands: Arc::clone(&cli_commands),
        shutdown: Arc::clone(&shutdown_notify),
        ping_interval_ms: resolve_ping_interval_ms(),
        hello_timeout_ms: resolve_hello_timeout_ms(),
        allowed_origins: Arc::new(resolve_allowed_origins()),
        ws_max_payload_bytes: resolve_ws_max_payload_bytes(),
        term09: freshell_ws::backpressure::Term09Config::from_env(),
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
    // Warm the cache in the background so the first real request never pays
    // the cold full-sweep cost. The scan itself runs in `spawn_blocking`
    // (inside `SessionIndex::snapshot`), so this never delays serving other
    // requests while it's in flight.
    if let Some(index) = &session_index {
        let warm_index = Arc::clone(index);
        // DIAG-01: log the initial warm sweep's count + duration (an
        // equivalent call to `index.warm()`'s own body -- `snapshot()` is
        // what `warm()` calls internally -- but keeping the return value
        // here lets this main.rs-scoped call site report a real count
        // instead of discarding it).
        tokio::spawn(async move {
            let start = std::time::Instant::now();
            let items = warm_index.snapshot().await;
            tracing::info!(
                event = "session_index_warm",
                count = items.len(),
                duration_ms = start.elapsed().as_millis() as u64,
                "session index warm sweep complete"
            );
        });
        // SESSION-09: start the periodic sessions.changed sweep -- see
        // `spawn_sessions_sweep`'s doc comment for the full parity rationale.
        // `ws_state` is Clone (cheap: every field is an Arc/primitive), so
        // this borrows nothing from the `ws_state` binding consumed by the
        // router merge below.
        spawn_sessions_sweep(Arc::clone(index), ws_state.clone(), SESSIONS_SWEEP_INTERVAL);
    }
    // Restore-across-restart fix: the amplifier locator's polling cycle (its
    // Enter↔session-dir correlation is entirely poll-driven -- see
    // `freshell_sessions::amplifier_locator`'s module doc for why this
    // substitutes for a live filesystem watcher). Independent of
    // `session_index`/the History feature -- restore must work even when the
    // History sidebar itself is unavailable.
    if amplifier_locator.is_some() {
        freshell_ws::amplifier_association::spawn_amplifier_locator_sweep(
            ws_state.clone(),
            AMPLIFIER_LOCATOR_SWEEP_INTERVAL,
        );
    }
    // OpenCode terminal-pane restore fix: the opencode locator's polling
    // cycle (its Enter/spawn<->session-row correlation is entirely
    // poll-driven -- see `freshell_sessions::opencode_locator`'s module doc).
    // Reuses the SAME cadence as the amplifier sweep above.
    if opencode_locator.is_some() {
        freshell_ws::opencode_association::spawn_opencode_locator_sweep(
            ws_state.clone(),
            AMPLIFIER_LOCATOR_SWEEP_INTERVAL,
        );
    }
    // DIAG-05: the diag router's `sessionsProjects` reads the SAME session
    // index (clone before the move below into `session_directory_state`).
    let diag_session_index = session_index.clone();
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
        // W5 fix-forward: the SAME shared `sessions.changed` bus + revision
        // counter minted above (and already wired into
        // `ws_state`/`fresh_agent_state`/`sessions::SessionsState`) so a
        // metadata tag change broadcasts on the ONE unified sequence.
        broadcast_tx: Arc::clone(&broadcast_tx),
        sessions_revision: Arc::clone(&sessions_revision),
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

    // SAFE-02: the global authenticated API rate limiter (checklist:
    // `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:539`).
    // ONE process-wide token bucket, wired below as the outermost-but-one
    // layer (see `rate_limit`'s module doc comment for the full legacy-parity
    // derivation of these defaults and the deliberate global-vs-per-IP scope
    // decision).
    let rate_limiter =
        rate_limit::RateLimiter::new_system(rate_limit::RateLimitConfig::default_api());

    // DIAG-05: `/api/server-info`, `/api/debug`, `/api/perf` -- shares the
    // live settings store, terminal registry, tabs registry, and session
    // index every other authenticated REST surface above already threads.
    let diag_state = diag::DiagState {
        auth_token: Arc::clone(&auth_token),
        app_version: Arc::clone(&app_version),
        boot_instant,
        settings: settings_store.clone(),
        registry: registry.clone(),
        tabs: tabs.clone(),
        session_index: diag_session_index,
        broadcast_tx: Arc::clone(&broadcast_tx),
    };

    let app = freshell_api::router(api_state)
        .merge(diag::router(diag_state))
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
                // NARROW live-reload fix: same shared registry seeded at boot
                // (TERM-11/TERM-13, above) so a successful PATCH also pushes
                // `safety.autoKillIdleMinutes`/`terminal.scrollback` live.
                registry: registry.clone(),
            },
        ))
        .merge(boot::router(boot_state))
        // Continuity trio Task 2: the tabs-sync snapshot read surface. The
        // `snapshots_dir` MUST match the `tabs-snapshots` dir wired into the
        // `TabsRegistry` above so the reads serve exactly what pushes persist.
        .merge(tabs_snapshots::router(tabs_snapshots::TabsSnapshotsState {
            auth_token: Arc::clone(&auth_token),
            snapshots_dir: home
                .as_ref()
                .map(|h| h.join(".freshell").join("tabs-snapshots")),
            fresh_agent: fresh_agent_state.clone(),
            screenshots: screenshots.clone(),
            terminals: registry.clone(), // the SAME TerminalRegistry from main.rs:246
            restore_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            restore_ack_timeout: std::time::Duration::from_secs(5),
        }))
        .merge(network::router(network_state))
        .merge(session_directory::router(session_directory_state))
        .merge(sessions::router(sessions::SessionsState {
            auth_token: Arc::clone(&auth_token),
            settings: settings_store.clone(),
            identity: terminal_identity.clone(),
            registry: registry.clone(),
            broadcast_tx: Arc::clone(&broadcast_tx),
            terminals_revision: Arc::clone(&terminals_revision),
            // GAP-1 fix (reviewer Important, SESSION-09 follow-up): the SAME
            // shared `sessions.changed` revision counter minted above (and
            // already wired into `fresh_agent_state`/`ws_state`) so an
            // override write (rename/archive/delete) broadcasts on the ONE
            // unified sequence instead of drifting out of sync with the
            // sweep/fresh-agent producers.
            sessions_revision: Arc::clone(&sessions_revision),
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
        // SAFE-02: the global authenticated API rate limit. Sits ABOVE (outside)
        // `ensure_json_charset` -- a rejection here short-circuits before that
        // inner layer runs, so `rate_limit::rate_limited_response` sets its own
        // `application/json; charset=utf-8` content-type directly rather than
        // depending on it. `rate_limit::enforce` itself exempts `/api/health`
        // and everything outside the `/api` prefix (the `/ws` upgrade, the
        // retained SPA's static assets) -- see that module's doc comment for
        // the full legacy-parity derivation (`server/index.ts:161-170`).
        .layer(axum::middleware::from_fn(move |req, next| {
            let rate_limiter = Arc::clone(&rate_limiter);
            async move { rate_limit::enforce(rate_limiter, req, next).await }
        }))
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
    // Provenance-hardening lane: the commit suffix (same `commit` value
    // `GET /api/server-info` reports, `diag.rs::build_commit()`) means an
    // operator tailing boot logs can identify exactly which source commit
    // is running without a separate authenticated request.
    eprintln!(
        "freshell-server listening on http://{addr} (ws://{addr}/ws) [commit {}]",
        diag::build_commit()
    );

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
    // DEV-0006 S4: stop accepting codex managed-launch plans and tear down every
    // launch sidecar + remote proxy the terminal-launch manager still owns (mirrors
    // legacy's close-time `codexLaunchPlanner.shutdown()` among the shutdown owners,
    // `server/index.ts:981-1049`). Runs AFTER `registry.kill_all()` above, so adopted
    // launches whose exit hooks already queued teardown are simply re-shut-down
    // (idempotent) and unadopted in-flight plans are reaped here. No-op when the
    // managed-launch flag never planned anything.
    freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
        .shutdown()
        .await;
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

/// SAFE-05: resolve the hello-handshake deadline, milliseconds. Mirrors
/// `ws-handler.ts:223`: `helloTimeoutMs: Number(process.env.HELLO_TIMEOUT_MS
/// || 5_000)`.
fn resolve_hello_timeout_ms() -> u64 {
    std::env::var("HELLO_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(5_000)
}

/// SAFE-06: resolve the inbound WS frame/message size bound. Mirrors
/// `ws-handler.ts:226`: `wsMaxPayloadBytes: Number(process.env.WS_MAX_PAYLOAD_BYTES
/// || 16 * 1024 * 1024)`.
fn resolve_ws_max_payload_bytes() -> usize {
    std::env::var("WS_MAX_PAYLOAD_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|&value| value > 0)
        .unwrap_or(16 * 1024 * 1024)
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

/// SESSION-09 sweep cadence: >= `SessionIndex`'s own TTL (`DEFAULT_TTL`, 1s)
/// so every tick's `snapshot()` call re-validates the on-disk corpus rather
/// than reading a stale cached snapshot. See [`spawn_sessions_sweep`]'s doc
/// comment for the full rationale (why a plain interval poll substitutes for
/// legacy's filesystem watcher, and why 2s also subsumes legacy's ~150ms
/// coalescing window).
const SESSIONS_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_millis(2000);

/// Restore-across-restart fix: the amplifier locator's poll cadence. Well
/// under `AMPLIFIER_DIR_APPEAR_WINDOW_MS` (2000ms) so a session dir that
/// appears anywhere in the correlation window is observed (and its
/// `events.jsonl` probed/confirmed) well before that window closes --
/// `freshell_sessions::amplifier_locator`'s module doc has the full
/// poll-vs-watcher rationale.
const AMPLIFIER_LOCATOR_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);

/// SESSION-09 (live sidebar updates): the signature a sessions-sweep tick
/// compares against the previous tick's signature to decide whether a
/// `sessions.changed` broadcast is warranted: `(corpus size, max
/// lastActivityAt)`. Cheap -- one pass over the already-parsed
/// `IndexedSession`s the sweep's `snapshot()` call already produced, no
/// extra I/O.
///
/// BOTH halves matter; max-`lastActivityAt` ALONE is not sufficient. A real
/// session-directory corpus routinely has some provider already sitting at
/// a later `lastActivityAt` than a session that just landed (e.g. a
/// restored/imported claude session appearing alongside codex/opencode
/// sessions dated further ahead -- exactly the shape
/// `session-directory-matrix.spec.ts`'s seeded corpus has). In that case the
/// max never moves, so a max-only token would silently swallow a real
/// corpus change (caught by `new_older_session_file_is_still_detected_as_a_change`
/// below -- this is not a hypothetical). Including the item COUNT catches
/// any add/remove regardless of the new item's own timestamp; the max
/// half still catches same-count changes (a new turn appended to an
/// existing session, bumping ITS `lastActivityAt` without changing corpus
/// size).
///
/// KNOWN GAPS (this sweep's signature ALONE is blind to all three; see the
/// per-item notes below for what closes or accepts each one):
///
/// 1. **Override-only changes (title/summary/archived/deleted overrides) --
///    CLOSED at the write site, not here.** `IndexedSession` carries no
///    override fields at all, so a rename/archive/delete PATCH never moves
///    this signature. Reviewer finding (Important): legacy broadcasts
///    `sessions.changed` on ANY sidebar-visible change (its differ,
///    `hasSessionDirectorySnapshotChange` / `projection.ts:23`, diffs the
///    FULL comparable snapshot including `archived`/`title`, re-run on
///    every `codingCliIndexer.refresh()` the legacy PATCH route triggers).
///    This port closes the gap at the SOURCE instead of widening the
///    sweep's signature: `sessions::patch_session` broadcasts
///    `sessions.changed` directly on a successful override write, sharing
///    this SAME `sessions_revision` counter (see
///    `sessions::SessionsState::sessions_revision`'s doc comment). Proven
///    by `patch_rename_broadcasts_sessions_changed_with_increased_revision`
///    and `patch_archive_broadcasts_sessions_changed_and_revision_is_monotonic`
///    in `sessions.rs`.
///
/// 2. **Delete+add in the SAME tick, count-neutral AND max-neutral --
///    ACCEPTED, exotic.** If one session is deleted and a different one
///    added within the same ~2s sweep window, and the composition happens
///    to leave both `len()` and the max `lastActivityAt` unchanged, this
///    signature cannot distinguish the pre/post corpus. This requires a
///    coincidental timestamp match across two unrelated sessions landing in
///    the same tick -- accepted as out of scope for a v1 poll-based sweep;
///    a filesystem watcher (not introduced here, see the FENCE note below)
///    would not have this gap either.
///
/// 3. **External-process override edits (bake-in with the legacy Node
///    server writing the SAME `config.json`) -- ACCEPTED for bake-in.** The
///    `SettingsStore`'s mtime-checked freshness reload
///    (`maybe_reload_overrides`, `settings_store.rs`) adopts an
///    externally-written override into THIS process's in-memory settings
///    on the next override READ, but that reload is READ-path-triggered
///    and does not itself broadcast -- so a bake-in-partner write to
///    `config.json` (not routed through THIS process's `patch_session`)
///    updates what the next request sees without pushing a
///    `sessions.changed` frame to already-connected WS clients. Only
///    writes that go through `sessions::patch_session` on THIS process
///    close gap 1 above; a foreign process's direct file write does not.
///    Accepted: bake-in is a transitional deployment mode, not the target
///    single-process architecture.
///
/// No committed provider parser currently allows a title-only rename with
/// no new turn to ALSO leave the sweep signature blind at the source-file
/// level (a title is always derived from message content that also carries
/// its own timestamp) -- gap 1 above is about the OVERRIDE layer
/// (`sessionOverrides` in `config.json`), which is orthogonal to the
/// parsed-file layer this signature covers. Legacy's fuller comparison
/// (`hasSessionDirectorySnapshotChange`,
/// `server/sessions-sync/service.ts`) additionally hashes file
/// content/mtime to catch this class of edit; that fuller comparison is
/// intentionally NOT ported here.
fn sessions_sweep_signature(
    items: &[freshell_sessions::directory_index::IndexedSession],
) -> (usize, i64) {
    let max_last_activity_at = items.iter().map(|s| s.last_activity_at).max().unwrap_or(0);
    (items.len(), max_last_activity_at)
}

/// SESSION-09: periodic sweep that detects session-directory changes and
/// broadcasts `sessions.changed` so the sidebar (`src/App.tsx:924-932`)
/// refetches its active session window WITHOUT a page reload. Legacy's
/// `SessionsSyncService` (`server/sessions-sync/service.ts:31-73`) watches
/// the directory with a real filesystem watcher and coalesces bursts of
/// writes into ONE broadcast (a ~150ms debounce); this port has no
/// filesystem watcher wired to the session directory (see
/// `freshell_sessions::directory_index` module docs -- the index is
/// request-pull / TTL-refreshed, not push-driven), so this sweep
/// substitutes a plain `tokio::time::interval` poll for "was there a
/// change" instead.
///
/// The interval (`SESSIONS_SWEEP_INTERVAL`, 2s) is deliberately >= the
/// `SessionIndex`'s own TTL (1s) so every tick's `snapshot()` call
/// re-validates the corpus against disk -- a cheap stat-only pass over
/// every file when nothing changed (see the incremental-cache design on
/// `SessionIndex`'s module doc: only a file whose `(mtime, size)` changed
/// since the last sweep gets re-parsed; an unchanged file costs one
/// `fs::metadata` call, not a re-read + re-parse). The 2s cadence also
/// subsumes legacy's ~150ms coalescing window: any burst of writes that
/// lands inside one tick collapses into a single broadcast -- same end
/// result, coarser granularity.
///
/// `MissedTickBehavior::Skip` (rather than tokio's default `Burst`): if a
/// tick is delayed (e.g. the sweep's own `snapshot()` call runs long on an
/// exceptionally large corpus), catch up by skipping the missed ticks
/// instead of firing them back-to-back -- there's nothing to gain from
/// re-sweeping the same on-disk state twice in quick succession.
///
/// Seeds `last_token` from a snapshot taken BEFORE the loop starts so boot
/// never emits a spurious broadcast: the client's own initial HTTP fetch
/// already reflects this exact corpus, so a `sessions.changed` firing
/// immediately after boot would trigger a redundant (harmless but
/// wasteful) refetch.
///
/// FENCE: no filesystem watcher (inotify/`notify`) is introduced here, and
/// `freshell_sessions::directory_index`'s internals are untouched -- this
/// function only calls the existing public `SessionIndex::snapshot()` API.
fn spawn_sessions_sweep(
    session_index: Arc<freshell_sessions::directory_index::SessionIndex>,
    ws_state: WsState,
    interval: std::time::Duration,
) {
    tokio::spawn(async move {
        let mut last_signature = sessions_sweep_signature(&session_index.snapshot().await);
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let items = session_index.snapshot().await;
            let signature = sessions_sweep_signature(&items);
            if signature != last_signature {
                last_signature = signature;
                freshell_ws::terminal::broadcast_sessions_changed(&ws_state);
            }
        }
    });
}

#[cfg(test)]
mod sessions_sweep_tests {
    use super::*;
    use freshell_sessions::directory_index::{
        ClaudeSource, IndexedSession, SessionIndex, SessionSource,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn unique_temp_dir(label: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "freshell-sessions-sweep-{label}-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    /// A minimal `<home>/.claude/projects/-p/<name>.jsonl` layout (same
    /// two-level shape `freshell_sessions::directory_index`'s own
    /// `claude_home_with` test helper uses -- that one is private to its
    /// crate, so this is a from-scratch equivalent, not a reuse). Each
    /// session gets ONE `user`-typed line carrying a canonical-shaped
    /// (36-char, dashed, v4) `sessionId`, a real `cwd` (required -- R10b
    /// excludes cwd-less files), and an explicit `timestamp` so the test
    /// fully controls `lastActivityAt` instead of depending on committed
    /// fixture content.
    fn write_claude_session(claude_home: &Path, session_id: &str, cwd: &str, timestamp: &str) {
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        let line = serde_json::json!({
            "type": "user",
            "sessionId": session_id,
            "cwd": cwd,
            "message": { "role": "user", "content": "hello" },
            "timestamp": timestamp,
        })
        .to_string();
        std::fs::write(
            project.join(format!("{session_id}.jsonl")),
            format!("{line}\n"),
        )
        .unwrap();
    }

    fn mk_indexed(last_activity_at: i64) -> IndexedSession {
        IndexedSession {
            session_id: "s".to_string(),
            provider: "claude".to_string(),
            project_path: "/tmp".to_string(),
            title: None,
            summary: None,
            first_user_message: None,
            last_activity_at,
            created_at: None,
            cwd: Some("/tmp".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    #[test]
    fn empty_snapshot_signature_is_zero_count_zero_activity() {
        assert_eq!(sessions_sweep_signature(&[]), (0, 0));
    }

    #[test]
    fn signature_pairs_count_with_the_max_last_activity_at() {
        let items = vec![mk_indexed(100), mk_indexed(500), mk_indexed(200)];
        assert_eq!(sessions_sweep_signature(&items), (3, 500));
    }

    /// The scenario the sweep task depends on: writing a NEW session file
    /// (with a later `lastActivityAt`) into the watched home changes the
    /// signature on the next `SessionIndex::snapshot()` call. `with_ttl(0)`
    /// forces every `snapshot()` call to re-validate against disk (no TTL
    /// window to wait out), matching the task pattern
    /// `SessionIndex::with_ttl(0ms) + tempdir claude fixtures`.
    #[tokio::test]
    async fn new_session_file_changes_the_signature() {
        let claude_home = unique_temp_dir("advance").join(".claude");
        write_claude_session(
            &claude_home,
            "11111111-1111-4111-8111-111111111111",
            "/tmp/sweep-test/alpha",
            "2025-01-01T00:00:00.000Z",
        );
        let index = SessionIndex::with_ttl(
            vec![Arc::new(ClaudeSource::new(claude_home.clone())) as Arc<dyn SessionSource>],
            std::time::Duration::from_millis(0),
        );
        let before = sessions_sweep_signature(&index.snapshot().await);
        assert_ne!(
            before,
            (0, 0),
            "seed session should produce a nonzero signature"
        );

        // A second, distinct session with a LATER timestamp lands in the
        // same watched home -- simulating a real provider write mid-session.
        write_claude_session(
            &claude_home,
            "22222222-2222-4222-8222-222222222222",
            "/tmp/sweep-test/beta",
            "2025-01-02T00:00:00.000Z",
        );
        // Stale-while-revalidate (rust-tauri-port bounded-warm-sweep fix): the
        // triggering `snapshot()` call may return the OLD signature
        // immediately while the actual re-scan runs detached in the
        // background -- poll until it settles instead of asserting on the
        // immediate return value (the periodic `spawn_sessions_sweep` this
        // mirrors already tolerates this same one-tick lag in production).
        let mut after = sessions_sweep_signature(&index.snapshot().await);
        for _ in 0..50 {
            if after != before {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            after = sessions_sweep_signature(&index.snapshot().await);
        }
        assert_ne!(
            after, before,
            "signature should change after a new, later-activity session file appears (before={before:?}, after={after:?})"
        );

        std::fs::remove_dir_all(claude_home.parent().unwrap()).ok();
    }

    /// The corpus-composition bug this reproduces: a REAL session-directory
    /// mix routinely has SOME provider already at a later `lastActivityAt`
    /// than a brand-new session that just landed (e.g. codex/opencode seeds
    /// dated ahead of a freshly-restored/imported claude session). A pure
    /// max-`lastActivityAt` token would NOT change here, silently swallowing
    /// a real corpus change. The sweep signature must also account for
    /// corpus SIZE so a new session is detected even when its own activity
    /// timestamp is not the new maximum.
    #[tokio::test]
    async fn new_older_session_file_is_still_detected_as_a_change() {
        let claude_home = unique_temp_dir("older").join(".claude");
        // Seed session is ALREADY the max-activity session in the corpus.
        write_claude_session(
            &claude_home,
            "44444444-4444-4444-8444-444444444444",
            "/tmp/sweep-test/already-latest",
            "2030-01-01T00:00:00.000Z",
        );
        let index = SessionIndex::with_ttl(
            vec![Arc::new(ClaudeSource::new(claude_home.clone())) as Arc<dyn SessionSource>],
            std::time::Duration::from_millis(0),
        );
        let before = sessions_sweep_signature(&index.snapshot().await);

        // A new session lands with an OLDER timestamp than the existing
        // max -- e.g. a restored/imported session, or (as in the
        // `session-directory-matrix` E2E corpus) a claude session seeded
        // alongside codex/opencode sessions dated further ahead.
        write_claude_session(
            &claude_home,
            "55555555-5555-4555-8555-555555555555",
            "/tmp/sweep-test/new-but-older",
            "2020-01-01T00:00:00.000Z",
        );
        // Stale-while-revalidate: poll until the detached background sweep
        // settles (see `new_session_file_changes_the_signature`'s comment).
        let mut after = sessions_sweep_signature(&index.snapshot().await);
        for _ in 0..50 {
            if after != before {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            after = sessions_sweep_signature(&index.snapshot().await);
        }
        assert_ne!(
            after, before,
            "a new session file must be detected as a change even when its own \
             activity timestamp is older than an already-present session (before={before:?}, after={after:?})"
        );

        std::fs::remove_dir_all(claude_home.parent().unwrap()).ok();
    }

    /// The counterpart: an UNCHANGED home (no writes between sweeps) must
    /// keep a stable signature -- the sweep must never broadcast spuriously.
    #[tokio::test]
    async fn unchanged_home_keeps_a_stable_signature() {
        let claude_home = unique_temp_dir("stable").join(".claude");
        write_claude_session(
            &claude_home,
            "33333333-3333-4333-8333-333333333333",
            "/tmp/sweep-test/gamma",
            "2025-01-01T00:00:00.000Z",
        );
        let index = SessionIndex::with_ttl(
            vec![Arc::new(ClaudeSource::new(claude_home.clone())) as Arc<dyn SessionSource>],
            std::time::Duration::from_millis(0),
        );
        let first = sessions_sweep_signature(&index.snapshot().await);
        let second = sessions_sweep_signature(&index.snapshot().await);
        assert_eq!(first, second, "an unchanged home must yield a stable token");

        std::fs::remove_dir_all(claude_home.parent().unwrap()).ok();
    }
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
