//! Wizard + launch-chooser commands — the Rust analog of the `preload.ts` IPC
//! surface for the two auxiliary windows (`electron-tauri.md §2` rows 9-11) and
//! their `entry.ts` handlers:
//!   * `complete-setup` (`entry.ts:513-528` → `patchDesktopConfig`), driven by the
//!     wizard (`setup-wizard/main.tsx:18-21`); validation from `wizard-logic.ts`.
//!   * `get-launch-options` (`entry.ts:530-532` → `launch-options.ts`), read by the
//!     chooser (`chooser.tsx:39`).
//!   * `choose-launch-option` (`entry.ts:534-555` → `launch-choice-handler.ts`),
//!     driven by the chooser (`chooser.tsx:50`); validators from `chooser-logic.ts`.
//!
//! Each privileged command is honored ONLY from its owning window
//! ([`crate::windows::is_allowed_window`]) — the Rust analog of the `webContents.id`
//! `isAllowedSender` gate (`entry.ts:538-541`), enforced in-command because
//! app-defined commands are not permission-gated in Tauri v2. The **validators +
//! patch/result builders are pure and unit-tested**; the `#[tauri::command]`
//! wrappers are thin seams doing the I/O (persist to `desktop.json`, port
//! bind-check).
//!
//! Deferred (part of the full launch-policy port, not this features task, and
//! flagged): live server **discovery** feeding the chooser's candidate list, live
//! **token validation** against `{url}/api/settings` (`launch-choice-handler.ts:64`),
//! and the `restartMain` re-derive-and-relaunch transition (`entry.ts:543-554`),
//! which belongs to the [`crate::state_machine`] wiring. `daemon` mode wiring stays
//! deferred (CD-5, below).
//
// CD candidate: CD-5 daemon-dead-end — `electron/daemon/**` `install()`/`uninstall()`
// are never called anywhere, so selecting `daemon` mode throws "not installed" with
// no install path (`startup.ts:345-352`). The wizard here can persist
// serverMode:"daemon" but, like the reference, cannot install the service. The port
// should wire install/uninstall into the wizard's daemon selection — antagonist call.

use serde::{Deserialize, Serialize};

// --- Wizard (complete-setup) -----------------------------------------------

/// Port bounds (`wizard-logic.ts:22-23`, `chooser-logic.ts:38`).
pub const PORT_MIN: u32 = 1024;
pub const PORT_MAX: u32 = 65535;
/// Wizard defaults (`wizard-logic.ts:20-21`).
pub const DEFAULT_PORT: u32 = 3001;
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+`";

/// The wizard's finished config (`preload.ts:6-12` `WizardSetupConfig`), camelCase
/// from the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WizardSetupConfig {
    pub server_mode: String,
    pub port: u32,
    #[serde(default)]
    pub remote_url: String,
    #[serde(default)]
    pub remote_token: String,
    #[serde(default)]
    pub global_hotkey: String,
}

/// Validate a port (`wizard-logic.ts:28-33`): 1024–65535. `None` = valid.
pub fn validate_port(port: u32) -> Option<String> {
    if !(PORT_MIN..=PORT_MAX).contains(&port) {
        Some(format!("Port must be between {PORT_MIN} and {PORT_MAX}"))
    } else {
        None
    }
}

/// Validate a URL (`wizard-logic.ts:39-46`): must parse. `None` = valid.
pub fn validate_url(value: &str) -> Option<String> {
    match url::Url::parse(value) {
        Ok(_) => None,
        Err(_) => Some("Please enter a valid URL".to_string()),
    }
}

/// Whether the wizard's config is valid enough to persist (the `canAdvance`
/// gate for the `configuration` step, `wizard-logic.ts:52-66`, applied to the
/// final config): remote needs a valid URL; daemon/app-bound need a valid port.
pub fn validate_wizard_config(cfg: &WizardSetupConfig) -> Option<String> {
    match cfg.server_mode.as_str() {
        "remote" => validate_url(&cfg.remote_url),
        "daemon" | "app-bound" => validate_port(cfg.port),
        other => Some(format!("Unknown server mode: {other}")),
    }
}

/// Build the `desktop.json` patch `complete-setup` persists (`entry.ts:513-528`):
/// serverMode/port/globalHotkey + setupCompleted:true; empty remoteUrl/remoteToken
/// map to absent (`|| undefined`), so they are omitted from the patch.
pub fn build_wizard_patch(cfg: &WizardSetupConfig) -> serde_json::Value {
    let mut patch = serde_json::json!({
        "serverMode": cfg.server_mode,
        "port": cfg.port,
        "globalHotkey": cfg.global_hotkey,
        "setupCompleted": true,
    });
    let obj = patch.as_object_mut().unwrap();
    if !cfg.remote_url.is_empty() {
        obj.insert("remoteUrl".into(), cfg.remote_url.clone().into());
    }
    if !cfg.remote_token.is_empty() {
        obj.insert("remoteToken".into(), cfg.remote_token.clone().into());
    }
    patch
}

// --- Launch chooser --------------------------------------------------------

/// A discovered/entered launch candidate (subset of `types.ts` `LaunchServerCandidate`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCandidate {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub requires_auth: Option<bool>,
    #[serde(default)]
    pub label: Option<String>,
}

/// The `get-launch-options` payload (`launch-options.ts:3-9`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOptionsResponse {
    pub candidates: Vec<LaunchCandidate>,
    pub reason: String,
    pub always_ask_on_launch: bool,
    pub port: u32,
    pub remote_url: String,
}

/// Build the launch-options payload (`launch-options.ts:16-27`). `pending` is the
/// discovered candidate set + reason (empty until the full discovery flow is wired).
pub fn build_launch_options(
    pending: Option<(Vec<LaunchCandidate>, String)>,
    always_ask_on_launch: bool,
    port: u32,
    remote_url: String,
) -> LaunchOptionsResponse {
    let (candidates, reason) = pending.unwrap_or_else(|| {
        (
            Vec::new(),
            "Choose how Freshell should connect.".to_string(),
        )
    });
    LaunchOptionsResponse {
        candidates,
        reason,
        always_ask_on_launch,
        port,
        remote_url,
    }
}

/// A launch choice from the chooser (`types.ts` `LaunchChoiceSchema` / `preload.ts`
/// `LaunchChoice`). Runtime-validated because it crosses the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchChoice {
    pub kind: String, // connect | remote | start-local
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub port: Option<u32>,
    #[serde(default)]
    pub requires_auth: Option<bool>,
    pub always_ask_on_launch: bool,
    pub remember: bool,
}

/// The result the chooser receives (`preload.ts:24-26` `LaunchChoiceResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchChoiceResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LaunchChoiceResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
        }
    }
}

/// The explicit forced launch a chosen option produces (`types.ts` `ForcedLaunch`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForcedLaunch {
    Connect { url: String, token: Option<String> },
    StartLocal { port: u32 },
}

/// Trim + strip trailing slashes (`launch-discovery.ts` `normalizeServerUrl`).
pub fn normalize_server_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

/// Validate a remote launch URL (`chooser-logic.ts:31-40`): http/https only.
pub fn validate_remote_launch_url(value: &str) -> Option<String> {
    match url::Url::parse(value) {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => None,
        _ => Some("Enter a valid http or https URL".to_string()),
    }
}

/// Validate a launch port (`chooser-logic.ts:47-52`): integer in 1024–65535.
pub fn validate_launch_port(port: u32) -> Option<String> {
    if !(PORT_MIN..=PORT_MAX).contains(&port) {
        Some("Enter a port between 1024 and 65535".to_string())
    } else {
        None
    }
}

/// The decision a validated launch choice yields — either a rejection message
/// (`{ok:false,error}`) or an acceptance carrying the config patch, the forced
/// launch, and which authoritative I/O checks the wrapper must still run
/// (`launch-choice-handler.ts:30-135`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchDecision {
    Rejected(String),
    Accepted {
        patch: serde_json::Value,
        forced: ForcedLaunch,
        /// A remote token to validate against the server (`validateServerAuth`);
        /// the wrapper performs this network check (deferred/flow-gated).
        auth_check: Option<(String, String)>,
        /// A local port to authoritatively bind-check (`isPortAvailable`) before
        /// spawning; the wrapper performs this (`port-check.ts`).
        port_check: Option<u32>,
    },
}

/// Validate + plan a launch choice (`launch-choice-handler.ts:30-135`), minus the
/// async I/O (surfaced as `auth_check`/`port_check` for the wrapper). Pure — the
/// full accept/reject matrix is unit-tested.
pub fn plan_launch_choice(choice: &LaunchChoice, current_port: u32) -> LaunchDecision {
    match choice.kind.as_str() {
        "remote" | "connect" => plan_connect(choice),
        "start-local" => plan_start_local(choice, current_port),
        _ => LaunchDecision::Rejected("Invalid launch request.".to_string()),
    }
}

fn plan_connect(choice: &LaunchChoice) -> LaunchDecision {
    let Some(raw_url) = choice.url.as_deref().filter(|u| !u.is_empty()) else {
        return LaunchDecision::Rejected("Choose a server URL.".to_string());
    };
    let url = normalize_server_url(raw_url);
    if let Some(err) = validate_remote_launch_url(&url) {
        return LaunchDecision::Rejected(err);
    }
    let token = choice
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    // requiresAuth defaults true (`launch-choice-handler.ts:60` `!== false`).
    let requires_auth = choice.requires_auth != Some(false);
    if requires_auth && token.is_none() {
        return LaunchDecision::Rejected(format!("Enter a token for {url}"));
    }
    let token = token.map(str::to_string);

    // remember → persist as the new default remote; else only alwaysAskOnLaunch
    // (`launch-choice-handler.ts:77-90`).
    let patch = if choice.remember {
        let mut p = serde_json::json!({
            "serverMode": "remote",
            "remoteUrl": url,
            "alwaysAskOnLaunch": choice.always_ask_on_launch,
            "setupCompleted": true,
        });
        if let Some(t) = &token {
            p.as_object_mut()
                .unwrap()
                .insert("remoteToken".into(), t.clone().into());
        }
        p
    } else {
        serde_json::json!({ "alwaysAskOnLaunch": choice.always_ask_on_launch })
    };

    let auth_check = if requires_auth {
        token.clone().map(|t| (url.clone(), t))
    } else {
        None
    };
    LaunchDecision::Accepted {
        patch,
        forced: ForcedLaunch::Connect { url, token },
        auth_check,
        port_check: None,
    }
}

fn plan_start_local(choice: &LaunchChoice, current_port: u32) -> LaunchDecision {
    let port = choice.port.unwrap_or(current_port);
    if let Some(err) = validate_launch_port(port) {
        return LaunchDecision::Rejected(err);
    }
    let patch = if choice.remember {
        serde_json::json!({
            "serverMode": "app-bound",
            "port": port,
            "alwaysAskOnLaunch": choice.always_ask_on_launch,
            "setupCompleted": true,
        })
    } else {
        serde_json::json!({ "alwaysAskOnLaunch": choice.always_ask_on_launch })
    };
    LaunchDecision::Accepted {
        patch,
        forced: ForcedLaunch::StartLocal { port },
        auth_check: None,
        port_check: Some(port),
    }
}

/// Authoritative port bind-check (`port-check.ts:11-21`): can we `listen` on this
/// port on all interfaces right now? Errs toward "occupied" on any bind error.
pub fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
}

// --- Tauri command seams ---------------------------------------------------
// The #[tauri::command] wrappers live at the module ROOT (not a submodule) so
// `generate_handler!` finds their generated `__cmd__*` siblings at `commands::*`.

use crate::config;
use crate::windows::{is_allowed_window, PrivilegedCommand};

/// `complete-setup` — persist the wizard config to `desktop.json`. Wizard-window
/// only (`entry.ts:513`). Validates before persisting.
#[tauri::command]
pub fn complete_setup(
    window: tauri::WebviewWindow,
    config: WizardSetupConfig,
) -> Result<(), String> {
    if !is_allowed_window(PrivilegedCommand::CompleteSetup, window.label()) {
        return Err("complete-setup rejected: sender not allowed".to_string());
    }
    if let Some(err) = validate_wizard_config(&config) {
        return Err(err);
    }
    let path = crate::config::desktop_config_path()
        .ok_or_else(|| "no HOME to resolve desktop.json".to_string())?;
    let patch = build_wizard_patch(&config);
    config::patch_config_at(&path, &patch).map_err(|e| e.to_string())?;
    Ok(())
}

/// `get-launch-options` — the chooser's initial data. Chooser-window only.
/// Reads `alwaysAskOnLaunch`/`port`/`remoteUrl` from `desktop.json`; live
/// candidate discovery is deferred (empty list until the launch-policy flow).
#[tauri::command]
pub fn get_launch_options(window: tauri::WebviewWindow) -> Result<LaunchOptionsResponse, String> {
    if !is_allowed_window(PrivilegedCommand::GetLaunchOptions, window.label()) {
        return Err("get-launch-options rejected: sender not allowed".to_string());
    }
    let cfg = read_desktop_config();
    let always = cfg
        .get("alwaysAskOnLaunch")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let port = cfg
        .get("port")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(DEFAULT_PORT);
    let remote_url = cfg
        .get("remoteUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(build_launch_options(None, always, port, remote_url))
}

/// `choose-launch-option` — validate + persist a chooser selection. Chooser-window
/// only (`entry.ts:538-541`). Runs the authoritative port bind-check; the
/// `restartMain` transition is wired via the state machine (deferred), so this
/// returns `{ok:true}` once the choice is validated + persisted.
#[tauri::command]
pub fn choose_launch_option(
    window: tauri::WebviewWindow,
    choice: LaunchChoice,
) -> LaunchChoiceResult {
    if !is_allowed_window(PrivilegedCommand::ChooseLaunchOption, window.label()) {
        return LaunchChoiceResult::err("Unexpected launch request.");
    }
    let current_port = read_desktop_config()
        .get("port")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(DEFAULT_PORT);
    match plan_launch_choice(&choice, current_port) {
        LaunchDecision::Rejected(msg) => LaunchChoiceResult::err(msg),
        LaunchDecision::Accepted {
            patch, port_check, ..
        } => {
            // Authoritative port bind-check before committing a start-local.
            if let Some(port) = port_check {
                if port <= u16::MAX as u32 && !is_port_available(port as u16) {
                    return LaunchChoiceResult::err(format!(
                            "Port {port} is already in use. Choose a different port, or connect to that server."
                        ));
                }
            }
            // NOTE: live token validation (auth_check) against {url}/api/settings
            // is deferred (needs an HTTP client + a running target) — flow-gated.
            if let Some(path) = crate::config::desktop_config_path() {
                if let Err(e) = config::patch_config_at(&path, &patch) {
                    return LaunchChoiceResult::err(format!("Failed to save choice: {e}"));
                }
            }
            LaunchChoiceResult::ok()
        }
    }
}

fn read_desktop_config() -> serde_json::Value {
    crate::config::desktop_config_path()
        .and_then(|p| config::read_config_at(&p).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- wizard validation + patch -------------------------------------------

    #[test]
    fn validate_port_bounds() {
        assert!(validate_port(3001).is_none());
        assert!(validate_port(1024).is_none());
        assert!(validate_port(65535).is_none());
        assert!(validate_port(1023).is_some());
        assert!(validate_port(70000).is_some());
    }

    #[test]
    fn validate_url_accepts_and_rejects() {
        assert!(validate_url("http://localhost:3001").is_none());
        assert!(validate_url("https://example.com").is_none());
        assert!(validate_url("not a url").is_some());
        assert!(validate_url("").is_some());
    }

    #[test]
    fn wizard_config_validation_by_mode() {
        assert!(validate_wizard_config(&WizardSetupConfig {
            server_mode: "app-bound".into(),
            port: 3001,
            remote_url: String::new(),
            remote_token: String::new(),
            global_hotkey: DEFAULT_HOTKEY.into(),
        })
        .is_none());
        // remote needs a valid URL.
        assert!(validate_wizard_config(&WizardSetupConfig {
            server_mode: "remote".into(),
            port: 3001,
            remote_url: "bogus".into(),
            remote_token: String::new(),
            global_hotkey: String::new(),
        })
        .is_some());
        // unknown mode rejected.
        assert!(validate_wizard_config(&WizardSetupConfig {
            server_mode: "carrier-pigeon".into(),
            port: 3001,
            remote_url: String::new(),
            remote_token: String::new(),
            global_hotkey: String::new(),
        })
        .is_some());
    }

    #[test]
    fn wizard_patch_sets_setup_completed_and_omits_empty_remote() {
        let patch = build_wizard_patch(&WizardSetupConfig {
            server_mode: "app-bound".into(),
            port: 4000,
            remote_url: String::new(),
            remote_token: String::new(),
            global_hotkey: "CommandOrControl+`".into(),
        });
        assert_eq!(patch["serverMode"], "app-bound");
        assert_eq!(patch["port"], 4000);
        assert_eq!(patch["setupCompleted"], true);
        assert_eq!(patch["globalHotkey"], "CommandOrControl+`");
        assert!(patch.get("remoteUrl").is_none(), "empty remoteUrl omitted");
        assert!(patch.get("remoteToken").is_none());
    }

    #[test]
    fn wizard_patch_includes_remote_when_present() {
        let patch = build_wizard_patch(&WizardSetupConfig {
            server_mode: "remote".into(),
            port: 3001,
            remote_url: "https://box:3001".into(),
            remote_token: "secret".into(),
            global_hotkey: String::new(),
        });
        assert_eq!(patch["remoteUrl"], "https://box:3001");
        assert_eq!(patch["remoteToken"], "secret");
    }

    // ---- launch options -------------------------------------------------------

    #[test]
    fn launch_options_defaults_when_no_pending() {
        let r = build_launch_options(None, true, 3001, "https://box".into());
        assert!(r.candidates.is_empty());
        assert_eq!(r.reason, "Choose how Freshell should connect.");
        assert!(r.always_ask_on_launch);
        assert_eq!(r.port, 3001);
        assert_eq!(r.remote_url, "https://box");
    }

    #[test]
    fn launch_options_uses_pending_candidates() {
        let cand = LaunchCandidate {
            id: "c1".into(),
            url: "http://localhost:3001".into(),
            requires_auth: Some(true),
            label: None,
        };
        let r = build_launch_options(
            Some((vec![cand.clone()], "multiple".into())),
            false,
            3001,
            String::new(),
        );
        assert_eq!(r.candidates, vec![cand]);
        assert_eq!(r.reason, "multiple");
    }

    // ---- normalize + validators ----------------------------------------------

    #[test]
    fn normalize_strips_trailing_slashes_and_trims() {
        assert_eq!(
            normalize_server_url("  http://x:3001///  "),
            "http://x:3001"
        );
        assert_eq!(normalize_server_url("http://x:3001"), "http://x:3001");
    }

    #[test]
    fn remote_url_scheme_validation() {
        assert!(validate_remote_launch_url("http://x:3001").is_none());
        assert!(validate_remote_launch_url("https://x").is_none());
        assert!(validate_remote_launch_url("ftp://x").is_some());
        assert!(validate_remote_launch_url("file:///etc").is_some());
        assert!(validate_remote_launch_url("garbage").is_some());
    }

    // ---- plan_launch_choice: the accept/reject matrix ------------------------

    fn connect(remember: bool, token: Option<&str>, requires_auth: Option<bool>) -> LaunchChoice {
        LaunchChoice {
            kind: "connect".into(),
            url: Some("http://localhost:3001".into()),
            token: token.map(str::to_string),
            port: None,
            requires_auth,
            always_ask_on_launch: false,
            remember,
        }
    }

    #[test]
    fn connect_requires_url() {
        let mut c = connect(false, Some("t"), Some(true));
        c.url = None;
        assert_eq!(
            plan_launch_choice(&c, 3001),
            LaunchDecision::Rejected("Choose a server URL.".into())
        );
    }

    #[test]
    fn connect_requires_token_when_auth_required() {
        let c = connect(false, None, Some(true));
        assert_eq!(
            plan_launch_choice(&c, 3001),
            LaunchDecision::Rejected("Enter a token for http://localhost:3001".into())
        );
    }

    #[test]
    fn connect_without_auth_needs_no_token() {
        let c = connect(false, None, Some(false));
        match plan_launch_choice(&c, 3001) {
            LaunchDecision::Accepted {
                forced,
                auth_check,
                port_check,
                ..
            } => {
                assert_eq!(
                    forced,
                    ForcedLaunch::Connect {
                        url: "http://localhost:3001".into(),
                        token: None
                    }
                );
                assert_eq!(auth_check, None);
                assert_eq!(port_check, None);
            }
            other => panic!("expected accept, got {other:?}"),
        }
    }

    #[test]
    fn connect_remember_persists_remote_defaults() {
        let c = connect(true, Some("secret"), Some(true));
        match plan_launch_choice(&c, 3001) {
            LaunchDecision::Accepted {
                patch, auth_check, ..
            } => {
                assert_eq!(patch["serverMode"], "remote");
                assert_eq!(patch["remoteUrl"], "http://localhost:3001");
                assert_eq!(patch["remoteToken"], "secret");
                assert_eq!(patch["setupCompleted"], true);
                assert_eq!(
                    auth_check,
                    Some(("http://localhost:3001".into(), "secret".into()))
                );
            }
            other => panic!("expected accept, got {other:?}"),
        }
    }

    #[test]
    fn connect_no_remember_only_persists_always_ask() {
        let c = connect(false, Some("secret"), Some(true));
        match plan_launch_choice(&c, 3001) {
            LaunchDecision::Accepted { patch, .. } => {
                assert!(patch.get("serverMode").is_none());
                assert_eq!(patch["alwaysAskOnLaunch"], false);
            }
            other => panic!("expected accept, got {other:?}"),
        }
    }

    #[test]
    fn start_local_validates_port_and_requests_bind_check() {
        let good = LaunchChoice {
            kind: "start-local".into(),
            url: None,
            token: None,
            port: Some(4200),
            requires_auth: None,
            always_ask_on_launch: true,
            remember: true,
        };
        match plan_launch_choice(&good, 3001) {
            LaunchDecision::Accepted {
                patch,
                forced,
                port_check,
                ..
            } => {
                assert_eq!(forced, ForcedLaunch::StartLocal { port: 4200 });
                assert_eq!(port_check, Some(4200));
                assert_eq!(patch["serverMode"], "app-bound");
                assert_eq!(patch["port"], 4200);
            }
            other => panic!("expected accept, got {other:?}"),
        }
        // Bad port rejected.
        let bad = LaunchChoice {
            port: Some(80),
            ..good.clone()
        };
        assert_eq!(
            plan_launch_choice(&bad, 3001),
            LaunchDecision::Rejected("Enter a port between 1024 and 65535".into())
        );
    }

    #[test]
    fn start_local_defaults_to_current_port() {
        let c = LaunchChoice {
            kind: "start-local".into(),
            url: None,
            token: None,
            port: None,
            requires_auth: None,
            always_ask_on_launch: false,
            remember: false,
        };
        match plan_launch_choice(&c, 5555) {
            LaunchDecision::Accepted { forced, .. } => {
                assert_eq!(forced, ForcedLaunch::StartLocal { port: 5555 });
            }
            other => panic!("expected accept, got {other:?}"),
        }
    }

    #[test]
    fn unknown_kind_rejected() {
        let c = LaunchChoice {
            kind: "teleport".into(),
            url: None,
            token: None,
            port: None,
            requires_auth: None,
            always_ask_on_launch: false,
            remember: false,
        };
        assert_eq!(
            plan_launch_choice(&c, 3001),
            LaunchDecision::Rejected("Invalid launch request.".into())
        );
    }

    #[test]
    fn is_port_available_true_for_free_port() {
        // Allocate then free a port; it should read available.
        let port = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(is_port_available(port));
    }

    #[test]
    fn is_port_available_false_for_occupied_port() {
        let l = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        // While `l` holds the port, a bind on 0.0.0.0 must fail.
        assert!(!is_port_available(port));
    }

    #[test]
    fn launch_choice_result_serializes_ok_without_error_field() {
        let ok = serde_json::to_value(LaunchChoiceResult::ok()).unwrap();
        assert_eq!(ok, serde_json::json!({ "ok": true }));
        let err = serde_json::to_value(LaunchChoiceResult::err("nope")).unwrap();
        assert_eq!(err, serde_json::json!({ "ok": false, "error": "nope" }));
    }
}
