//! `freshell-tauri` — the Tauri v2 desktop shell (Phase 3.13), the "move to Tauri"
//! deliverable. It reproduces the Electron shell's **app-bound** boot path:
//!
//! 1. Spawn the cargo-built `freshell-server` binary on an ephemeral 127.0.0.1 port
//!    with a generated `AUTH_TOKEN` + the real desktop `HOME` ([`server`],
//!    mirroring `electron/server-spawner.ts` + `electron/startup.ts`
//!    `startAppBoundServer`).
//! 2. Health-gate `GET /api/health` (backoff 100 ms→5 s, 30 s, fail-fast on child
//!    exit — [`health`], 1:1 with `server-spawner.ts:46-81`).
//! 3. Load `http://127.0.0.1:<port>/?token=<token>` in the webview so the RETAINED
//!    React SPA runs unchanged ([`shim`] builds the `?token=` URL — `startup.ts:155`).
//! 4. Inject the 2-property `window.freshellDesktop` shim as an initialization
//!    script ([`shim`]), the whole frontend seam the SPA touches (electron-tauri.md §7).
//! 5. Reap the owned server on exit (SIGTERM→SIGKILL, [`server::reap_child`]).
//!
//! Single-instance (focus-first) via `tauri-plugin-single-instance`; the re-entrant
//! Electron `main()` becomes the explicit [`state_machine`]. Tray / global-shortcut
//! / updater / window-state / setup-wizard / launch-chooser / renderer-recovery /
//! daemon managers are DEFERRED to Phase 3.14 and cleanly omitted here.
//!
//! Additive only: nothing under `server/` or `shared/` is touched; the spawned
//! server is the same `freshell-server` binary the oracle grades. The modules are
//! `pub` so the headless integration test (`tests/server_spawn_smoke.rs`) can drive
//! the real spawn→health→reap path against the built server without a display.

pub mod commands;
pub mod config;
pub mod external_url;
pub mod health;
pub mod hotkey;
pub mod provisioning;
pub mod renderer_recovery;
pub mod server;
pub mod shim;
pub mod state_machine;
pub mod tray;
pub mod updater;
pub mod window_state;
pub mod windows;

use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Listener, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::server::{ReapOutcome, SpawnConfig};
use crate::state_machine::{
    decide_initial_phase, runnable_phase, BootInputs, ServerMode, ShellPhase,
};

/// Grace before escalating SIGTERM→SIGKILL when reaping the server
/// (`server-spawner.ts:178`, 5 s).
const REAP_GRACE: Duration = Duration::from_secs(5);
/// Poll interval while waiting for the graceful exit.
const REAP_POLL: Duration = Duration::from_millis(50);

/// The owned server child, shared between `setup` (spawner) and the run-loop
/// (reaper). `take()`-based so the server is reaped exactly once, no `pkill`.
type ServerSlot = Arc<Mutex<Option<Child>>>;

/// Build and run the Tauri desktop shell. Blocks in the event loop until the app
/// exits, then returns. On a fatal build/setup failure the spawned server (if any)
/// is reaped and the process exits non-zero.
pub fn run() {
    let server_slot: ServerSlot = Arc::new(Mutex::new(None));

    // Single-instance MUST be registered first (plugin docs; main.ts:24-28). A
    // second launch focuses the primary's main window (main.ts:63-70).
    let single_instance = tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    });

    let build_result = tauri::Builder::default()
        .plugin(single_instance)
        .plugin(tauri_plugin_opener::init())
        // Global hotkey plugin (electron/hotkey.ts). The single global handler
        // toggles the main window on the registered show/hide accelerator
        // (startup.ts:204-211); registration happens in setup (best-effort).
        .plugin(global_shortcut_plugin())
        .invoke_handler(tauri::generate_handler![
            external_url::open_external_url,
            // Per-window-gated wizard/chooser commands (electron/preload.ts §2).
            commands::complete_setup,
            commands::get_launch_options,
            commands::choose_launch_option,
        ])
        .setup({
            let server_slot = server_slot.clone();
            move |app| {
                // Remote provisioning first (electron/entry.ts:260-274 applies the
                // provision file BEFORE runStartup; startup.ts:360-380 then connects
                // a configured remote with NO app-bound spawn). Env pair or the
                // one-shot desktop.provision file → remote; else app-bound.
                if let Some(remote) = provisioning::resolve_provisioned_remote() {
                    setup_remote(app, &remote)?;
                } else {
                    setup_app_bound(app, &server_slot)?;
                }
                Ok(())
            }
        })
        .build(tauri::generate_context!());

    let app = match build_result {
        Ok(app) => app,
        Err(err) => {
            eprintln!("freshell-tauri: failed to start: {err}");
            // setup() may have already spawned the server before failing — reap it
            // so a failed launch never leaks a server (oracle "no orphans").
            reap_server(&server_slot);
            std::process::exit(1);
        }
    };

    app.run(move |_app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            reap_server(&server_slot);
        }
    });
}

/// The app-bound boot path, run inside Tauri's `setup` hook (main thread). Spawns +
/// health-gates the server, then creates the main window at the `?token=` URL with
/// the injected `freshellDesktop` shim. On any failure the spawned server is reaped
/// before the error propagates (which aborts the launch).
fn setup_app_bound(
    app: &mut tauri::App,
    server_slot: &ServerSlot,
) -> Result<(), Box<dyn std::error::Error>> {
    // Explicit state machine (NOT re-entrant main): decide the phase, then map to
    // what 3.13 can construct (wizard/chooser deferred → Main).
    let phase = runnable_phase(decide_initial_phase(BootInputs {
        // App-bound desktop: setup is treated complete (the wizard that would set
        // this is a 3.14 deliverable); server_mode is app-bound for this step.
        setup_completed: true,
        server_mode: ServerMode::AppBound,
    }));
    debug_assert_eq!(
        phase,
        ShellPhase::Main,
        "3.13 constructs only the Main phase"
    );

    // 1. Resolve inputs for the app-bound spawn.
    let server_binary = server::resolve_server_binary()?;
    let port = server::allocate_ephemeral_port()?;
    let token = server::generate_auth_token();
    let host = "127.0.0.1";

    let cfg = SpawnConfig {
        server_binary: server_binary.clone(),
        port,
        auth_token: token.clone(),
        bind_host: host.to_string(),
        // Inherit the real desktop HOME (production app-bound). An isolated home is
        // opt-in via FRESHELL_HOME on the child's inherited env.
        home: None,
        // Let the smoke/tests point the server at a built dist/client if needed.
        client_dir: std::env::var_os("FRESHELL_CLIENT_DIR").map(PathBuf::from),
        owner_tag: format!("freshell-tauri-{}", std::process::id()),
    };

    let plan = server::build_spawn_plan(&cfg);
    eprintln!(
        "freshell-tauri: spawning app-bound server {} on 127.0.0.1:{port}",
        server_binary.display()
    );
    let child = server::spawn_server(&plan)?;
    // Store immediately so every subsequent early-return path reaps it.
    *server_slot.lock().unwrap() = Some(child);

    // 2. Health-gate, failing fast if the child dies.
    let health = health::wait_for_health(host, port, health::DEFAULT_TIMEOUT, || {
        child_has_exited(server_slot)
    });
    if let Err(err) = health {
        eprintln!("freshell-tauri: server health gate failed: {err}");
        reap_server(server_slot);
        return Err(Box::new(err));
    }
    eprintln!("freshell-tauri: server healthy on 127.0.0.1:{port}");

    // 3. Load the retained SPA at the ?token= URL with the 2-property shim.
    let load_url = shim::build_load_url(host, port, &token);
    let parsed: url::Url = load_url.parse()?;
    WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::External(parsed))
        .title("Freshell")
        .inner_size(1200.0, 800.0)
        .initialization_script(shim::desktop_shim_script())
        .build()?;
    eprintln!(
        "freshell-tauri: main window loading {}",
        redact_token(&load_url)
    );

    // 4. Desktop features (Phase 3.17): tray, global hotkey, updater surface. ALL
    //    best-effort — a session-gated failure (headless / no tray / no key session)
    //    must never abort boot (`startup.ts:213-217` makes tray creation non-fatal;
    //    the port extends that to the hotkey + updater wiring too).
    wire_desktop_features(app, ServerMode::AppBound);

    // Headless-smoke hook: auto-quit after N ms so an xvfb smoke can prove the full
    // spawn→health→window→reap path and exit cleanly. No-op in normal use.
    install_smoke_exit(app);

    Ok(())
}

/// The remote boot path (provisioned remote, `startup.ts:360-380`): NO app-bound
/// spawn — health-gate the remote's `/api/health` (`checkRemoteReachable`,
/// `startup.ts:79-96`, made a bounded wait since there is no child to fail-fast
/// on), then load `<remoteUrl>/?token=<remoteToken>` with the same injected shim.
/// An unreachable remote aborts the launch (the reference would fall back to the
/// launch chooser — a deferred 3.14 window — so fail-fast is the honest analog).
fn setup_remote(
    app: &mut tauri::App,
    remote: &provisioning::RemoteConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let phase = runnable_phase(decide_initial_phase(BootInputs {
        // Provisioning marks setupCompleted:true (desktop-provisioning.ts:68-73).
        setup_completed: true,
        server_mode: ServerMode::Remote,
    }));
    debug_assert_eq!(phase, ShellPhase::Main, "a provisioned remote boots Main");

    let load_url = provisioning::remote_load_url(&remote.remote_url, &remote.remote_token);
    let parsed: url::Url = load_url.parse()?;
    let host = parsed
        .host_str()
        .ok_or("remote URL has no host")?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or("remote URL has no port")?;

    eprintln!("freshell-tauri: remote mode — connecting to {host}:{port} (no app-bound spawn)");
    if let Err(err) = health::wait_for_health(&host, port, health::DEFAULT_TIMEOUT, || false) {
        eprintln!("freshell-tauri: remote server health gate failed: {err}");
        return Err(Box::new(err));
    }
    eprintln!("freshell-tauri: remote server healthy on {host}:{port}");

    WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::External(parsed))
        .title("Freshell")
        .inner_size(1200.0, 800.0)
        .initialization_script(shim::desktop_shim_script())
        .build()?;
    eprintln!(
        "freshell-tauri: main window loading {}",
        redact_token(&load_url)
    );

    wire_desktop_features(app, ServerMode::Remote);
    install_smoke_exit(app);
    Ok(())
}

/// Headless-smoke hook shared by both boot paths: auto-quit after
/// `FRESHELL_TAURI_SMOKE_EXIT_MS` ms. No-op in normal use.
fn install_smoke_exit(app: &tauri::App) {
    if let Some(ms) = std::env::var("FRESHELL_TAURI_SMOKE_EXIT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            eprintln!("freshell-tauri: smoke exit after {ms}ms");
            handle.exit(0);
        });
    }
}

/// Whether the spawned server child has exited (fail-fast input to the health gate).
/// Returns true when the slot is empty (already reaped) as well.
fn child_has_exited(server_slot: &ServerSlot) -> bool {
    let mut guard = server_slot.lock().unwrap();
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
        None => true,
    }
}

/// Reap the owned server exactly once (SIGTERM→SIGKILL). Idempotent: a second call
/// finds the slot empty and does nothing.
fn reap_server(server_slot: &ServerSlot) {
    let child = server_slot.lock().unwrap().take();
    if let Some(mut child) = child {
        let outcome = server::reap_child(&mut child, REAP_GRACE, REAP_POLL);
        match outcome {
            ReapOutcome::AlreadyExited => {
                eprintln!("freshell-tauri: server already exited")
            }
            ReapOutcome::Graceful => eprintln!("freshell-tauri: server reaped (SIGTERM)"),
            ReapOutcome::Forced => eprintln!("freshell-tauri: server reaped (SIGKILL)"),
        }
    }
}

/// Redact the `?token=` value for logging (the token is a live credential).
fn redact_token(url: &str) -> String {
    match url.split_once("?token=") {
        Some((base, _)) => format!("{base}?token=<redacted>"),
        None => url.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Desktop-features wiring (Phase 3.17). All seams are best-effort + session-gated:
// they only do real work under a display session (tray/hotkey need one), and never
// abort boot on failure. Live behavior is not headlessly verifiable (electron-
// tauri.md §8 items 7/8/12).
// ---------------------------------------------------------------------------

/// The global-shortcut plugin (electron/hotkey.ts). One global handler toggles the
/// main window's visibility on the registered accelerator (`startup.ts:204-211`);
/// the accelerator itself is registered in [`wire_desktop_features`].
fn global_shortcut_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_global_shortcut::ShortcutState;
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_main_window(app);
            }
        })
        .build()
}

/// Toggle the main window: hide if visible+focused, else show+focus
/// (`startup.ts:206-210`).
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// Register the show/hide global hotkey, translating the Electron accelerator to
/// the plugin grammar first ([`hotkey::translate_accelerator`]). Best-effort: a
/// translate/parse/register failure is logged, not fatal (headless has no session
/// to grab a hotkey on).
fn register_global_hotkey<R: Runtime>(app: &AppHandle<R>, electron_accel: &str) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let translated = match hotkey::translate_accelerator(electron_accel) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("freshell-tauri: hotkey translate failed for {electron_accel:?}: {e}");
            return;
        }
    };
    let shortcut: tauri_plugin_global_shortcut::Shortcut = match translated.parse() {
        Ok(s) => s,
        Err(_) => {
            eprintln!("freshell-tauri: hotkey parse failed for {translated:?}");
            return;
        }
    };
    match app.global_shortcut().register(shortcut) {
        Ok(()) => eprintln!("freshell-tauri: global hotkey {translated:?} registered"),
        Err(e) => {
            eprintln!("freshell-tauri: global hotkey register failed (session-gated): {e}")
        }
    }
}

/// Wire the desktop features onto the running app: global hotkey + system tray +
/// the tray "Check for Updates" → updater-state surface. Best-effort throughout.
fn wire_desktop_features(app: &tauri::App, mode: ServerMode) {
    let handle = app.handle();

    // Global hotkey (best-effort; session-gated).
    register_global_hotkey(handle, hotkey::DEFAULT_HOTKEY);

    // System tray (best-effort; session-gated — non-fatal per startup.ts:213-217).
    #[cfg(feature = "tray")]
    {
        let status = tray::TrayStatus {
            running: true,
            mode: mode_str(mode).to_string(),
        };
        if let Err(e) = tray::build_tray(handle, &status) {
            eprintln!("freshell-tauri: tray creation failed (session-gated): {e}");
        }
        // Tray "Check for Updates" → surface the (signing-gated) updater state
        // instead of a silent no-op (CD-7). The live check/apply needs a signed
        // release + a real Ed25519 key + a feed — Phase-4 manual QA.
        let updater_handle = handle.clone();
        handle.listen(tray::TRAY_CHECK_UPDATES_EVENT, move |_event| {
            report_updater_state(&updater_handle);
        });
    }
    let _ = mode; // consumed only under the `tray` feature
}

/// The server-mode string shown in the tray + written to desktop.json.
#[cfg(feature = "tray")]
fn mode_str(mode: ServerMode) -> &'static str {
    match mode {
        ServerMode::AppBound => "app-bound",
        ServerMode::Daemon => "daemon",
        ServerMode::Remote => "remote",
    }
}

/// Report the auto-updater state (CD-7's explicit disabled surface). The runtime
/// updater config (endpoints + Ed25519 pubkey) comes from `tauri.conf.json`
/// `plugins.updater`; until a real key is provisioned the updater is DISARMED and
/// this says so out loud rather than silently doing nothing.
#[cfg(feature = "tray")]
fn report_updater_state<R: Runtime>(app: &AppHandle<R>) {
    // Read the REAL updater config from tauri.conf.json `plugins.updater` (endpoints
    // + Ed25519 pubkey). The shipped placeholder key → DisarmedNoPubkey, so the
    // config block is genuinely consumed (not inert). The live plugin is registered
    // only when armed (a real key exists) — deferred until a signed release.
    let plugins = serde_json::to_value(app.config().plugins.clone())
        .unwrap_or_else(|_| serde_json::json!({}));
    let cfg = updater::parse_updater_config(&plugins);
    match updater::updater_state(&cfg) {
        updater::UpdaterState::Armed => {
            eprintln!("freshell-tauri: checking for updates…")
        }
        updater::UpdaterState::DisarmedNoPubkey => eprintln!(
            "freshell-tauri: updater disarmed — no signing key configured (signing-gated; CD-7)"
        ),
        updater::UpdaterState::DisarmedNoEndpoint => {
            eprintln!("freshell-tauri: updater disarmed — no update endpoint configured")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_token_hides_the_credential() {
        assert_eq!(
            redact_token("http://127.0.0.1:51234/?token=deadbeef"),
            "http://127.0.0.1:51234/?token=<redacted>"
        );
        // No token → unchanged.
        assert_eq!(
            redact_token("http://127.0.0.1:51234/"),
            "http://127.0.0.1:51234/"
        );
    }

    #[test]
    fn empty_slot_reports_exited_and_reap_is_noop() {
        let slot: ServerSlot = Arc::new(Mutex::new(None));
        assert!(child_has_exited(&slot), "an empty slot counts as exited");
        // Reaping an empty slot must not panic.
        reap_server(&slot);
    }
}
