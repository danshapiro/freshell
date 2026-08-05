//! `GET /api/network/status` — the read-only network status (Follow-up 3.19).
//!
//! **FAITHFUL-PORT + unit-proven, NOT differential-oracle-proven.** No captured
//! original transcript exists for this read; correctness is argued by a faithful
//! port with file:line citations, the exact `NetworkStatus` shape
//! (`server/network-manager.ts:189-209`), and the unit tests below.
//!
//! Ports, additively (no `server/` or `shared/` source touched):
//! * `server/network-manager.ts` `getStatus()` (282-398) — the status derivation.
//! * `server/network-router.ts` `router.get('/network/status')` (421-429) — the
//!   route (returns the raw status; 500 on error).
//! * `server/network-access.ts` `isRemoteAccessEnabled` (via
//!   `freshell_platform::network::is_remote_access_enabled`).
//!
//! ## READ-ONLY + safety
//!
//! Every live probe here is READ-ONLY (`freshell_platform::detect_firewall` runs
//! only `netsh … show` / `ufw status`; LAN detection runs only `ipconfig.exe`).
//! Of the **mutating** network paths, NET-05 wires exactly one:
//! `POST /api/network/configure-firewall`'s **WSL2-repair slice** (the elevated
//! `netsh portproxy`/`FreshellLANAccess` plan, behind the two-phase confirmation
//! gate, with the reference's post-run recompute + verify + managed-ports
//! persist). The remaining mutating paths (`configure`, `disable-remote-access`,
//! the native-Windows elevated repair) stay golden-string builders in
//! `freshell-platform`, never executed here. The live facts are computed lazily
//! (on first request) and cached for the process life, mirroring the original's
//! `getFirewallInfo` / `ensureLanIps` memoization (so boot stays fast and repeat
//! reads are instant).
//!
//! ## NET-05 synchronous-reduction notes
//!
//! The reference spawns the elevated repair asynchronously (answering
//! `{status:'started'}` before PowerShell settles, flipping
//! `firewall.configuring`/`resetFirewallCache` around it). This portable
//! reduction runs the repair to completion INSIDE the confirm request, so the
//! in-flight window is internal to one request and never observable —
//! `firewall.configuring` stays `false` and the cached facts need no reset
//! (a WSL2 repair mutates no `LiveNetworkFacts` field: the firewall platform /
//! `active` flag and LAN IPs are untouched by adding a portproxy rule). The
//! status reconcile after a repair is therefore exactly: recompute the plan,
//! `verify_wsl_repair_plan`, persist the managed-ports file on success — all
//! done in [`execute_wsl2_repair_script`].
//!
//! ## Deferred (documented, loopback-faithful)
//!
//! The `0.0.0.0`-only live port-reachability probe (`isPortReachable`) and the
//! Windows managed-firewall-port staleness read are deferred: `raw_port_open`
//! is `None` and `stale` is `false`. On a loopback boot (the oracle's, and the
//! default) both are exactly the original's values (`portOpen` is `null` there
//! and there is no managed-Windows exposure), so this is faithful for that path;
//! for a `0.0.0.0` bind it degrades `portOpen` to `null` ("unknown"), never a
//! wrong `true`/`false`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use freshell_platform::detect::{host_os_live, is_wsl2_proc_live};
use freshell_platform::elevated::{
    spawn_elevated_powershell, ConfirmationAction, ConfirmationGate, ConfirmationResponse,
    ELEVATED_POWERSHELL_TIMEOUT_MS,
};
use freshell_platform::network::{access_url, is_remote_access_enabled, NetworkIntent};
use freshell_platform::port_forward::{
    compute_wsl_port_forwarding_plan, is_wsl_port_forwarding_disabled_by_env,
    managed_wsl_ports_path, persist_managed_wsl_remote_access_ports, verify_wsl_repair_plan,
    WslPortForwardingPlan,
};
use freshell_platform::{
    detect_firewall, firewall_commands, CommandRunner, Env, FirewallInfo, FirewallPlatform,
    RealEnv, StdCommandRunner,
};
use freshell_protocol::{NetworkHost, ServerSettings};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

use crate::boot::is_authed;

/// Shared state for the network-status route.
#[derive(Clone)]
pub struct NetworkState {
    /// The auth gate (`AUTH_TOKEN`) — same gate as the rest of `/api/*`.
    pub auth_token: Arc<String>,
    /// The full server settings tree (for `network.{configured,host}`).
    pub settings: Arc<ServerSettings>,
    /// The actual bound host (`127.0.0.1` / `0.0.0.0`) — the original uses the
    /// live `server.address()`; here that is the resolved bind host.
    pub effective_host: Arc<String>,
    /// The bound loopback port.
    pub port: u16,
    /// The lazily-computed, then-cached live host facts (firewall + LAN IPs +
    /// hostname). `OnceCell` so the first request pays the (read-only) subprocess
    /// cost and every subsequent read is instant.
    pub facts: Arc<OnceCell<LiveNetworkFacts>>,
    /// The two-phase confirmation-token / repair-in-flight gate (NET-05): the
    /// `currentConfirmation` + `confirmedRepairInFlight` state machine
    /// (`network-router.ts:90-91`). `std::sync::Mutex` — held only for the
    /// nanosecond-scale token checks, never across `.await` or subprocess IO.
    pub gate: Arc<Mutex<ConfirmationGate>>,
}

/// The live, read-only host facts consulted by `getStatus`.
#[derive(Clone, Debug)]
pub struct LiveNetworkFacts {
    pub firewall: FirewallInfo,
    pub lan_ips: Vec<String>,
    pub hostname: String,
}

/// The network sub-router (`GET /api/network/status` + the NET-05 WSL2 slice
/// of `POST /api/network/configure-firewall`), pre-bound to state.
pub fn router(state: NetworkState) -> Router {
    Router::new()
        .route("/api/network/status", get(network_status))
        .route("/api/network/configure-firewall", post(configure_firewall))
        .with_state(state)
}

/// Resolve the live facts once (read-only subprocesses on `spawn_blocking`),
/// then reuse the cache. Mirrors `getFirewallInfo()`/`ensureLanIps()` memoization.
async fn cached_facts(state: &NetworkState) -> &LiveNetworkFacts {
    state
        .facts
        .get_or_init(|| async {
            tokio::task::spawn_blocking(resolve_live_network_facts)
                .await
                .unwrap_or_else(|_| LiveNetworkFacts {
                    firewall: FirewallInfo {
                        platform: firewall_platform_fallback(),
                        active: false,
                    },
                    lan_ips: Vec::new(),
                    hostname: read_machine_hostname(),
                })
        })
        .await
}

async fn network_status(State(state): State<NetworkState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }

    let facts = cached_facts(&state).await;

    let network_host = network_host_str(&state.settings.network.host);
    let inputs = NetworkStatusInputs {
        configured: state.settings.network.configured,
        network_host,
        effective_host: state.effective_host.as_str(),
        port: state.port,
        lan_ips: &facts.lan_ips,
        machine_hostname: &facts.hostname,
        firewall: &facts.firewall,
        // Loopback-faithful: the 0.0.0.0-only reachability probe is deferred.
        raw_port_open: None,
        wsl_forwarding_disabled_by_env: is_wsl_port_forwarding_disabled_by_env(&RealEnv),
        token: state.auth_token.as_str(),
    };
    Json(build_network_status(inputs)).into_response()
}

/// The inputs to the pure [`build_network_status`] (everything the live edge
/// resolves), so the derivation is deterministic + unit-testable.
pub struct NetworkStatusInputs<'a> {
    pub configured: bool,
    pub network_host: &'a str,
    pub effective_host: &'a str,
    pub port: u16,
    pub lan_ips: &'a [String],
    pub machine_hostname: &'a str,
    pub firewall: &'a FirewallInfo,
    pub raw_port_open: Option<bool>,
    pub wsl_forwarding_disabled_by_env: bool,
    pub token: &'a str,
}

/// Pure port of `getStatus()`'s derivation (`network-manager.ts:325-397`). Every
/// field of the returned object matches the `NetworkStatus` interface
/// (`network-manager.ts:189-209`).
pub fn build_network_status(i: NetworkStatusInputs) -> Value {
    let platform = i.firewall.platform;
    let remote_access_ports: Vec<u16> = vec![i.port]; // getRemoteAccessPorts (no devMode)

    let network = NetworkIntent {
        configured: i.configured,
        host: i.network_host.to_string(),
    };
    let remote_access_requested =
        is_remote_access_enabled(Some(&network), i.effective_host, platform);

    // Windows managed-port staleness read is deferred (read-only, Windows-only) → false.
    let stale = false;
    let port_open = if stale { Some(false) } else { i.raw_port_open };

    let commands = if i.firewall.active {
        // The Windows stale-repair branch is deferred (stale == false), so this is
        // always the plain suggested-command builder (golden strings; wsl2 → []).
        firewall_commands(platform, &remote_access_ports)
    } else {
        Vec::new()
    };

    let remote_access_enabled = if platform == FirewallPlatform::Wsl2 {
        i.raw_port_open == Some(true)
    } else {
        remote_access_requested && i.raw_port_open == Some(true)
    };

    let remote_access_needs_repair = (platform == FirewallPlatform::Wsl2
        && remote_access_requested
        && port_open == Some(false)
        && !i.wsl_forwarding_disabled_by_env)
        || (platform == FirewallPlatform::Windows
            && remote_access_requested
            && (i.raw_port_open == Some(false) || stale));

    let share_route_enabled = remote_access_enabled
        || (platform == FirewallPlatform::Wsl2
            && remote_access_requested
            && i.raw_port_open.is_none()
            && !i.wsl_forwarding_disabled_by_env);

    let access_port = i.port; // no devMode
    let url = access_url(share_route_enabled, i.lan_ips, access_port, i.token);

    json!({
        "configured": i.configured,
        "host": i.effective_host,
        "remoteAccessEnabled": remote_access_enabled,
        "remoteAccessRequested": remote_access_requested,
        "remoteAccessNeedsRepair": remote_access_needs_repair,
        "port": i.port,
        "lanIps": i.lan_ips,
        "machineHostname": i.machine_hostname,
        "firewall": {
            "platform": platform.as_str(),
            "active": i.firewall.active,
            "portOpen": match port_open { Some(b) => Value::Bool(b), None => Value::Null },
            "commands": commands,
            "configuring": false,
        },
        "rebinding": false,
        "devMode": false,
        "accessUrl": url,
    })
}

/// Map the settings `NetworkHost` enum to the wire string (`"127.0.0.1"`/`"0.0.0.0"`).
fn network_host_str(host: &NetworkHost) -> &'static str {
    match host {
        NetworkHost::Loopback => "127.0.0.1",
        NetworkHost::AllInterfaces => "0.0.0.0",
    }
}

/// Compute the live, read-only host facts (blocking — call on `spawn_blocking`).
fn resolve_live_network_facts() -> LiveNetworkFacts {
    let host_os = host_os_live();
    let is_wsl2 = is_wsl2_proc_live();
    let runner = StdCommandRunner::default();

    // READ-ONLY firewall state (`netsh … show` / `ufw status` / `defaults read`).
    let firewall = detect_firewall(host_os, is_wsl2, &runner);

    // LAN IPs (`detectLanIps`, `bootstrap.ts:182-193`): on WSL, query the
    // Windows host's physical adapters (READ-ONLY `ipconfig.exe`, ranked with
    // the reference's assumed /24). On NATIVE WINDOWS, the reference falls
    // through to `detectLanIpsFromInterfaces()` (`os.networkInterfaces()`,
    // every non-internal IPv4 with its real netmask, ranked) — wired here via
    // a READ-ONLY PowerShell object query (task-005e part 2, item 2; verified
    // against the win-side `node os.networkInterfaces()` ground truth). On
    // other non-WSL hosts (native Linux/macOS — outside this port's verified
    // matrix), the interfaces edge remains unwired (empty) — documented; it
    // only affects the 0.0.0.0 share path.
    let lan_ips = if is_wsl2 {
        freshell_platform::network::detect_lan_ips_via_ipconfig(&runner)
    } else if cfg!(windows) {
        freshell_platform::network::detect_lan_ips_from_windows_interfaces(&runner)
    } else {
        Vec::new()
    };

    LiveNetworkFacts {
        firewall,
        lan_ips,
        hostname: read_machine_hostname(),
    }
}

/// `os.hostname().replace(/\.local$/, '')` (`network-manager.ts:385`).
///
/// Unix/WSL: `/proc/sys/kernel/hostname` → `HOSTNAME` env → `"localhost"`.
/// NATIVE WINDOWS: `hostname.exe` (whose output equals Node's
/// `os.hostname()`/`gethostname()` byte-for-byte — verified live on the QA
/// host: both print `SurfaceBookPro9` while `COMPUTERNAME` is the UPPERCASED
/// NetBIOS name `SURFACEBOOKPRO9`, which would be WRONG) → `COMPUTERNAME`
/// env → `"localhost"` (task-005e part 2, item 2).
fn read_machine_hostname() -> String {
    let raw = if cfg!(windows) {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "localhost".to_string())
    } else {
        std::fs::read_to_string("/proc/sys/kernel/hostname")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "localhost".to_string())
    };
    raw.strip_suffix(".local").unwrap_or(&raw).to_string()
}

/// The platform used if the live detection task itself fails to join (defensive).
fn firewall_platform_fallback() -> FirewallPlatform {
    if is_wsl2_proc_live() {
        FirewallPlatform::Wsl2
    } else {
        FirewallPlatform::LinuxNone
    }
}

// ---------------------------------------------------------------------------
// `POST /api/network/configure-firewall` — NET-05, WSL2-repair slice
// ---------------------------------------------------------------------------

/// The parsed body of `POST /api/network/configure-firewall`
/// (`ConfigureFirewallRequestSchema`, `network-router.ts:23-26`).
pub struct ConfigureFirewallRequest {
    pub confirm_elevation: bool,
    pub confirmation_token: Option<String>,
}

/// Port of `ConfigureFirewallRequestSchema.safeParse(req.body ?? {})`
/// (`network-router.ts:23-26,618-621`): a STRICT object — Express hands the
/// route `{}` for an empty/missing JSON body; `confirmElevation` may only be
/// the literal `true`; `confirmationToken`, when present, a non-empty string.
/// Any violation → 400 `{error:'Invalid request', details}` (zod's `issues`
/// array itself is not reproduced — its content is zod-internal).
pub fn parse_configure_firewall_body(body: &[u8]) -> Result<ConfigureFirewallRequest, Response> {
    let invalid = || {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": [] })),
        )
            .into_response()
    };
    let value: Value = if body.iter().all(|b| b.is_ascii_whitespace()) {
        json!({})
    } else {
        match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(_) => return Err(invalid()),
        }
    };
    let Some(obj) = value.as_object() else {
        return Err(invalid());
    };
    // `.strict()` — unknown keys reject.
    if !obj
        .keys()
        .all(|k| k == "confirmElevation" || k == "confirmationToken")
    {
        return Err(invalid());
    }
    // `z.literal(true).optional()`.
    let confirm_elevation = match obj.get("confirmElevation") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err(invalid()),
    };
    // `z.string().min(1).optional()`.
    let confirmation_token = match obj.get("confirmationToken") {
        None => None,
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(_) => return Err(invalid()),
    };
    Ok(ConfigureFirewallRequest {
        confirm_elevation,
        confirmation_token,
    })
}

/// Serialize the gate's [`ConfirmationResponse`] to the wire shape
/// (`WINDOWS_ELEVATION_CONFIRMATION` + `confirmationToken`, camelCase keys —
/// `network-router.ts:28-33,223-228`).
fn confirmation_json(resp: &ConfirmationResponse) -> Value {
    json!({
        "method": resp.method,
        "title": resp.title,
        "body": resp.body,
        "confirmLabel": resp.confirm_label,
        "confirmationToken": resp.confirmation_token,
    })
}

/// The reference's `consumeCurrentConfirmation` on a confirmed request that
/// resolves to none/terminal/error (`network-router.ts:639-648`): the stale
/// token is dropped so a later unrelated elevation cannot consume it.
fn consume_current_confirmation_if_confirmed(state: &NetworkState, req: &ConfigureFirewallRequest) {
    if req.confirm_elevation {
        state
            .gate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .consume_current_confirmation(req.confirmation_token.as_deref());
    }
}

/// The resolution of the request BEFORE any WSL2 plan compute
/// (`resolveRepairAction`, `network-router.ts:264-320`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigureFirewallAction {
    /// 200 `{method:'none', message}` — nothing to do (reference early exits).
    None {
        method: &'static str,
        message: &'static str,
    },
    /// 200 `{method:'terminal', command}` — suggested non-elevated commands.
    Terminal { command: String },
    /// A reference branch tonight's WSL2 slice deliberately does not wire
    /// (the elevated native-Windows repair — see [`resolve_pre_plan`]). Mapped
    /// to the reference's 500 catch shape (`network-router.ts:754-757`).
    Deferred,
    /// 500 `{error}` — the resolution/plan itself failed.
    Error(String),
    /// The elevated WSL2 repair plan is ready: gate it behind the two-phase
    /// confirmation before dispatching (`network-router.ts:288-293,653-733`).
    Wsl2Confirmable { script: String },
    /// The caller must compute the WSL2 plan (live READ-ONLY netsh reads) and
    /// feed it to [`wsl2_plan_action`].
    ComputeWsl2Plan,
}

/// `resolveRepairAction`'s pre-plan branches (`network-router.ts:268-319`).
///
/// `commands` is the same folded command list the status payload serves
/// (`firewall_commands(platform, ports)` when the firewall is active, else
/// `[]`); `port_open` is the (deferred → always `None` here) reachability
/// probe, so the `portOpen === true` early exits never fire on this port —
/// they are kept for wire-shape fidelity.
pub fn resolve_pre_plan(
    remote_access_requested: bool,
    platform: FirewallPlatform,
    port_open: Option<bool>,
    commands: &[String],
) -> ConfigureFirewallAction {
    if !remote_access_requested {
        // REMOTE_ACCESS_DISABLED (`network-router.ts:40-43,268-270`).
        return ConfigureFirewallAction::None {
            method: "none",
            message: "Remote access is not enabled",
        };
    }
    match platform {
        FirewallPlatform::Wsl2 => {
            if port_open == Some(true) {
                // NO_CONFIGURATION_CHANGES_REQUIRED (`network-router.ts:273-275`).
                return ConfigureFirewallAction::None {
                    method: "none",
                    message: "No configuration changes required",
                };
            }
            ConfigureFirewallAction::ComputeWsl2Plan
        }
        FirewallPlatform::Windows => {
            // `network-router.ts:296-310`. The elevated `windows-repair`
            // onSuccess persists the managed-Windows-ports store
            // (`persistManagedWindowsRemoteAccessPorts`) — the ONLY record of
            // which firewall rules are Freshell-owned — which this port keeps
            // deferred. Running the elevation without that record could orphan
            // rules the reference would later know to clean up, so the
            // elevated branch waits for its own task; the data-only early
            // exits below are exact.
            if commands.is_empty() {
                ConfigureFirewallAction::None {
                    method: "none",
                    message: "No firewall detected",
                }
            } else if port_open == Some(true) {
                ConfigureFirewallAction::None {
                    method: "none",
                    message: "No configuration changes required",
                }
            } else {
                ConfigureFirewallAction::Deferred
            }
        }
        _ => {
            // `network-router.ts:312-319` (linux/macos — non-elevated hint).
            if commands.is_empty() {
                ConfigureFirewallAction::None {
                    method: "none",
                    message: "No firewall detected",
                }
            } else {
                ConfigureFirewallAction::Terminal {
                    command: commands.join(" && "),
                }
            }
        }
    }
}

/// The `wsl2` branch tail of `resolveRepairAction` (`network-router.ts:281-294`).
pub fn wsl2_plan_action(plan: &WslPortForwardingPlan) -> ConfigureFirewallAction {
    match plan {
        WslPortForwardingPlan::Error(message) => ConfigureFirewallAction::Error(message.clone()),
        WslPortForwardingPlan::NotWsl2
        | WslPortForwardingPlan::Disabled
        | WslPortForwardingPlan::Noop { .. } => ConfigureFirewallAction::None {
            method: "none",
            message: "No configuration changes required",
        },
        // confirmationAction 'wsl2-repair' / responseMethod 'wsl2'.
        WslPortForwardingPlan::Ready { script, .. } => ConfigureFirewallAction::Wsl2Confirmable {
            script: script.clone(),
        },
    }
}

/// The post-confirm `wsl2-repair` pipeline, synchronous-reduced
/// (`startElevatedRepair` + `verifyWslRepairSuccess` +
/// `persistCurrentWslRemoteAccessPorts`, `network-router.ts:150-216,380-391,
/// 703-718`):
///
/// 1. dispatch the elevated script through the injected runner (UAC);
/// 2. on spawn failure — report the reference's `failedLog`, verify nothing,
///    persist nothing;
/// 3. recompute the plan against the just-repaired host and map it through
///    [`verify_wsl_repair_plan`];
/// 4. only when verification passes, persist the managed-ports state file
///    (the reference's `onSuccess`, skipped by its `catch` otherwise).
pub struct Wsl2RepairExecution {
    pub verification: Result<(), String>,
    pub persisted_managed_ports: bool,
}

/// See [`Wsl2RepairExecution`]. `spawn_runner` elevates (120s, UAC-paced);
/// `read_runner` re-runs the READ-ONLY plan reads. Both are fakes in tests.
pub fn execute_wsl2_repair_script(
    env: &dyn Env,
    spawn_runner: &dyn CommandRunner,
    read_runner: &dyn CommandRunner,
    managed_ports_file: &Path,
    remote_access_ports: &[u16],
    script: &str,
) -> Wsl2RepairExecution {
    let out = spawn_elevated_powershell(
        spawn_runner,
        ConfirmationAction::Wsl2Repair.powershell_command(),
        script,
    );
    if !out.ok() {
        // `failedLog` (`network-router.ts:181-183,711`) — no verify, no persist.
        return Wsl2RepairExecution {
            verification: Err("WSL2 port forwarding failed".to_string()),
            persisted_managed_ports: false,
        };
    }
    let plan = compute_wsl_port_forwarding_plan(
        true,
        env,
        read_runner,
        managed_ports_file,
        remote_access_ports,
        remote_access_ports,
    );
    let verification = verify_wsl_repair_plan(&plan);
    let persisted_managed_ports = verification.is_ok()
        && persist_managed_wsl_remote_access_ports(managed_ports_file, remote_access_ports).is_ok();
    Wsl2RepairExecution {
        verification,
        persisted_managed_ports,
    }
}

/// The `wsl2-repair` half of the route's confirmable branch
/// (`network-router.ts:651-738`), synchronous-reduced (see module notes):
///
/// 1. in-flight → 409 `{error, method:'in-progress'}`;
/// 2. no / mismatched confirmation → 200 with a freshly issued token (NO
///    spawn — `network-router.ts:659-661`);
/// 3. lock + consume the token, then dispatch + verify + persist via
///    [`execute_wsl2_repair_script`];
/// 4. release the lock; 200 `{method:'wsl2', status:'started'}` on pass, 500
///    `{error}` (the reference's `failedLog` message) on spawn/verify
///    failure.
///
/// The reference's under-lock re-derivation of status+plan collapses in this
/// reduction: the plan was computed from fresh READ-ONLY reads moments
/// earlier in the same request, and the gate mutex serializes the confirm
/// window, so the only re-check that can matter (the token) is re-run as
/// `consume_confirmation` for shape fidelity. `new_token` is generated at
/// the (async) edge so this stays deterministic in tests.
pub fn confirm_and_execute_wsl2_repair(
    gate: &Mutex<ConfirmationGate>,
    confirm_elevation: bool,
    confirmation_token: Option<&str>,
    new_token: &str,
    script: &str,
    env: &dyn Env,
    spawn_runner: &dyn CommandRunner,
    read_runner: &dyn CommandRunner,
    managed_ports_file: &Path,
    remote_access_ports: &[u16],
) -> (StatusCode, Value) {
    let mut g = gate.lock().unwrap_or_else(|p| p.into_inner());
    if g.is_repair_in_flight() {
        return (
            StatusCode::CONFLICT,
            json!({
                "error": "Firewall configuration already in progress",
                "method": "in-progress",
            }),
        );
    }
    // Phase 1 / stale token (`network-router.ts:659-661`): issue, never spawn.
    if !confirm_elevation
        || !g.matches_confirmation(confirmation_token, ConfirmationAction::Wsl2Repair)
    {
        let resp = g.issue_confirmation(ConfirmationAction::Wsl2Repair, new_token);
        return (StatusCode::OK, confirmation_json(&resp));
    }
    if !g.try_acquire_repair_lock() {
        return (
            StatusCode::CONFLICT,
            json!({
                "error": "Firewall configuration already in progress",
                "method": "in-progress",
            }),
        );
    }
    // Freshly matched above, so this consume cannot fail in the synchronous
    // reduction — kept for shape fidelity: a failure re-issues, never spawns.
    if !g.consume_confirmation(confirmation_token, ConfirmationAction::Wsl2Repair) {
        g.release_repair_lock();
        let resp = g.issue_confirmation(ConfirmationAction::Wsl2Repair, new_token);
        return (StatusCode::OK, confirmation_json(&resp));
    }
    drop(g);

    let exec = execute_wsl2_repair_script(
        env,
        spawn_runner,
        read_runner,
        managed_ports_file,
        remote_access_ports,
        script,
    );
    gate.lock()
        .unwrap_or_else(|p| p.into_inner())
        .release_repair_lock();
    match exec.verification {
        Ok(()) => (
            StatusCode::OK,
            json!({ "method": "wsl2", "status": "started" }),
        ),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": error })),
    }
}

/// The route's live WSL2 plan-read edge (`network-router.ts:280-284`), run on
/// `spawn_blocking`. `is_wsl2` is `true` here because this helper is only
/// reached when the cached facts' firewall platform is `Wsl2` (itself derived
/// from `/proc/version` in `detect_firewall`). The managed-ports state file
/// lives under the WSL user's home (Node `os.homedir()` semantics — env
/// `HOME`, never `FRESHELL_HOME`).
fn compute_live_wsl2_plan(remote_access_ports: &[u16]) -> WslPortForwardingPlan {
    let env = RealEnv;
    let runner = StdCommandRunner::default(); // READ-ONLY `show` reads only here
    let managed = managed_wsl_ports_path(&PathBuf::from(env.or_default("HOME", "/tmp")));
    compute_wsl_port_forwarding_plan(
        true,
        &env,
        &runner,
        &managed,
        remote_access_ports,
        remote_access_ports,
    )
}

/// `POST /api/network/configure-firewall` (`network-router.ts:618-758`) —
/// NET-05 wires the full early-exit ladder plus the WSL2-repair confirmable
/// branch; the native-Windows ELEVATED repair stays deferred (see
/// [`resolve_pre_plan`]) and reports the reference's 500 catch shape.
async fn configure_firewall(
    State(state): State<NetworkState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }
    let req = match parse_configure_firewall_body(&body) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    // The in-flight pre-check precedes any resolution (`network-router.ts:623-628`).
    if state
        .gate
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .is_repair_in_flight()
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Firewall configuration already in progress",
                "method": "in-progress",
            })),
        )
            .into_response();
    }

    // `resolveRepairAction(status, settings)` — the same cached facts the
    // status route serves (the deferred reachability probe feeds `None`
    // here exactly as in `getStatus`).
    let facts = cached_facts(&state).await;
    let platform = facts.firewall.platform;
    let network = NetworkIntent {
        configured: state.settings.network.configured,
        host: network_host_str(&state.settings.network.host).to_string(),
    };
    let remote_access_requested =
        is_remote_access_enabled(Some(&network), state.effective_host.as_str(), platform);
    let remote_access_ports: Vec<u16> = vec![state.port]; // getRemoteAccessPorts (no devMode)
    let commands = if facts.firewall.active {
        firewall_commands(platform, &remote_access_ports)
    } else {
        Vec::new()
    };

    let resolved = match resolve_pre_plan(remote_access_requested, platform, None, &commands) {
        ConfigureFirewallAction::ComputeWsl2Plan => {
            let ports = remote_access_ports.clone();
            let plan = tokio::task::spawn_blocking(move || compute_live_wsl2_plan(&ports))
                .await
                .unwrap_or_else(|_| {
                    WslPortForwardingPlan::Error("Firewall configuration failed".to_string())
                });
            wsl2_plan_action(&plan)
        }
        other => other,
    };

    match resolved {
        ConfigureFirewallAction::Error(error) => {
            consume_current_confirmation_if_confirmed(&state, &req);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error })),
            )
                .into_response()
        }
        ConfigureFirewallAction::None { method, message } => {
            consume_current_confirmation_if_confirmed(&state, &req);
            Json(json!({ "method": method, "message": message })).into_response()
        }
        ConfigureFirewallAction::Terminal { command } => {
            consume_current_confirmation_if_confirmed(&state, &req);
            Json(json!({ "method": "terminal", "command": command })).into_response()
        }
        ConfigureFirewallAction::Deferred => {
            // Documented NET-05 deferral (native-Windows elevated repair):
            // the reference's catch shape (`network-router.ts:754-757`).
            consume_current_confirmation_if_confirmed(&state, &req);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Firewall configuration failed" })),
            )
                .into_response()
        }
        ConfigureFirewallAction::Wsl2Confirmable { script } => {
            let gate = Arc::clone(&state.gate);
            let new_token = uuid::Uuid::new_v4().to_string();
            let result = tokio::task::spawn_blocking(move || {
                let env = RealEnv;
                // The elevated, UAC-paced spawn gets the reference's 120s
                // timeout (`ELEVATED_POWERSHELL_TIMEOUT_MS`); the post-run
                // READ-ONLY re-reads stay on the default 5s `tryExec` pace.
                let spawn_runner = StdCommandRunner::with_timeout(
                    std::time::Duration::from_millis(ELEVATED_POWERSHELL_TIMEOUT_MS),
                );
                let read_runner = StdCommandRunner::default();
                let managed =
                    managed_wsl_ports_path(&PathBuf::from(env.or_default("HOME", "/tmp")));
                confirm_and_execute_wsl2_repair(
                    &gate,
                    req.confirm_elevation,
                    req.confirmation_token.as_deref(),
                    &new_token,
                    &script,
                    &env,
                    &spawn_runner,
                    &read_runner,
                    &managed,
                    &remote_access_ports,
                )
            })
            .await;
            match result {
                Ok((code, body)) => (code, Json(body)).into_response(),
                Err(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "Firewall configuration failed" })),
                )
                    .into_response(),
            }
        }
        ConfigureFirewallAction::ComputeWsl2Plan => {
            unreachable!("ComputeWsl2Plan is resolved to a plan action above")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl2_inactive() -> FirewallInfo {
        FirewallInfo {
            platform: FirewallPlatform::Wsl2,
            active: false,
        }
    }

    #[test]
    fn loopback_wsl2_boot_is_remote_access_off_and_shape_complete() {
        let fw = wsl2_inactive();
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "127.0.0.1",
            effective_host: "127.0.0.1",
            port: 51234,
            lan_ips: &[],
            machine_hostname: "dandesktop",
            firewall: &fw,
            raw_port_open: None,
            wsl_forwarding_disabled_by_env: false,
            token: "tok-abc",
        });

        // Full NetworkStatus shape present.
        for key in [
            "configured",
            "host",
            "remoteAccessEnabled",
            "remoteAccessRequested",
            "remoteAccessNeedsRepair",
            "port",
            "lanIps",
            "machineHostname",
            "firewall",
            "rebinding",
            "devMode",
            "accessUrl",
        ] {
            assert!(status.get(key).is_some(), "missing {key}");
        }
        assert_eq!(status["configured"], json!(true));
        assert_eq!(status["host"], json!("127.0.0.1"));
        assert_eq!(status["remoteAccessEnabled"], json!(false));
        assert_eq!(status["remoteAccessRequested"], json!(false));
        assert_eq!(status["remoteAccessNeedsRepair"], json!(false));
        assert_eq!(status["port"], json!(51234));
        assert_eq!(status["machineHostname"], json!("dandesktop"));
        assert_eq!(status["rebinding"], json!(false));
        assert_eq!(status["devMode"], json!(false));

        // Firewall sub-shape: wsl2, portOpen null, no commands, not configuring.
        let fw_v = &status["firewall"];
        assert_eq!(fw_v["platform"], json!("wsl2"));
        assert_eq!(fw_v["active"], json!(false));
        assert_eq!(fw_v["portOpen"], Value::Null);
        assert_eq!(fw_v["commands"], json!([]));
        assert_eq!(fw_v["configuring"], json!(false));

        // accessUrl carries the (encoded) token, localhost (no share route).
        assert_eq!(
            status["accessUrl"],
            json!("http://localhost:51234/?token=tok-abc")
        );
    }

    #[test]
    fn all_interfaces_unconfigured_requests_remote_access_and_builds_commands() {
        // Non-WSL (linux ufw active), bound 0.0.0.0, unconfigured → remote access
        // requested; active firewall → the ufw suggested commands (golden strings).
        let fw = FirewallInfo {
            platform: FirewallPlatform::LinuxUfw,
            active: true,
        };
        let status = build_network_status(NetworkStatusInputs {
            configured: false,
            network_host: "0.0.0.0",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.1.20".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: None, // probe deferred → unknown
            wsl_forwarding_disabled_by_env: false,
            token: "t",
        });
        assert_eq!(status["host"], json!("0.0.0.0"));
        assert_eq!(status["remoteAccessRequested"], json!(true));
        // Commands are the golden ufw builder output (data only — never executed).
        assert_eq!(
            status["firewall"]["commands"],
            json!(firewall_commands(FirewallPlatform::LinuxUfw, &[3001]))
        );
        assert!(!status["firewall"]["commands"]
            .as_array()
            .unwrap()
            .is_empty());
        // portOpen unknown (deferred probe) → null; remoteAccessEnabled false.
        assert_eq!(status["firewall"]["portOpen"], Value::Null);
        assert_eq!(status["remoteAccessEnabled"], json!(false));
    }

    #[test]
    fn hostname_strips_dot_local_suffix() {
        // The transformation the original applies; here exercised on a fixed input
        // via the pure builder (the live reader applies the same strip).
        let fw = wsl2_inactive();
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "127.0.0.1",
            effective_host: "127.0.0.1",
            port: 1,
            lan_ips: &[],
            machine_hostname: "macbook", // already stripped by read_machine_hostname
            firewall: &fw,
            raw_port_open: None,
            wsl_forwarding_disabled_by_env: false,
            token: "t",
        });
        assert_eq!(status["machineHostname"], json!("macbook"));
    }

    // ---- NET-03: accurate share URL across the reachability truth table ---
    //
    // `share_route_enabled` and `accessUrl` below are the faithful port of
    // `network-manager.ts:349-375`; the live probe that feeds `raw_port_open`
    // (`network-manager.ts:303-320`) is NET-01's deferred slice. These tests
    // pin the contract that probe completes: for each probe outcome the share
    // URL is accurate — protocol/host/port + percent-encoded token
    // (`network-manager.ts:370-375`) — or degrades to loopback exactly where
    // the reference does (`portOpen === null/false`), never a wrong LAN URL.

    #[test]
    fn share_url_uses_first_lan_ip_when_probe_reachable_on_non_wsl2_bind() {
        // Windows host explicitly configured for 0.0.0.0 (the PW-TAURI-WIN
        // surface), probe says the LAN address reaches the server: the share
        // route activates and accessUrl points at the first LAN IP with the
        // real bound port.
        let fw = FirewallInfo {
            platform: FirewallPlatform::Windows,
            active: false,
        };
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "0.0.0.0",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.1.50".to_string(), "10.0.0.5".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: Some(true),
            wsl_forwarding_disabled_by_env: false,
            token: "tok",
        });
        assert_eq!(status["remoteAccessRequested"], json!(true));
        assert_eq!(status["remoteAccessEnabled"], json!(true));
        assert_eq!(status["remoteAccessNeedsRepair"], json!(false));
        assert_eq!(status["firewall"]["portOpen"], json!(true));
        assert_eq!(
            status["accessUrl"],
            json!("http://192.168.1.50:3001/?token=tok")
        );
    }

    #[test]
    fn share_url_uses_lan_ip_when_probe_reachable_on_unconfigured_linux_bind() {
        // Unconfigured 0.0.0.0 bind (HOST/FRESHELL_BIND_HOST path): remote
        // access is requested by default off-WSL2 (`network-access.ts:16-18`),
        // so a reachable probe turns the LAN share URL on here too.
        let fw = FirewallInfo {
            platform: FirewallPlatform::LinuxUfw,
            active: true,
        };
        let status = build_network_status(NetworkStatusInputs {
            configured: false,
            network_host: "127.0.0.1",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.1.20".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: Some(true),
            wsl_forwarding_disabled_by_env: false,
            token: "t",
        });
        assert_eq!(status["remoteAccessRequested"], json!(true));
        assert_eq!(status["remoteAccessEnabled"], json!(true));
        assert_eq!(
            status["accessUrl"],
            json!("http://192.168.1.20:3001/?token=t")
        );
    }

    #[test]
    fn share_url_stays_loopback_when_probe_unreachable_on_non_wsl2_bind() {
        // Bound 0.0.0.0 and requested, but the port provably does not reach
        // the LAN: the reference never advertises a broken URL — loopback URL
        // (`network-manager.ts:371-372`), and Windows flags the repair state
        // (`network-manager.ts:357-361`).
        let fw = FirewallInfo {
            platform: FirewallPlatform::Windows,
            active: true,
        };
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "0.0.0.0",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.1.50".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: Some(false),
            wsl_forwarding_disabled_by_env: false,
            token: "tok",
        });
        assert_eq!(status["remoteAccessEnabled"], json!(false));
        assert_eq!(status["firewall"]["portOpen"], json!(false));
        assert_eq!(status["remoteAccessNeedsRepair"], json!(true));
        assert_eq!(
            status["accessUrl"],
            json!("http://localhost:3001/?token=tok")
        );
    }

    #[test]
    fn share_url_stays_loopback_while_probe_unknown_on_non_wsl2_bind() {
        // `None` == the reference's `rawPortOpen === null` (probe threw /
        // not run): NO share route even when remote access is requested
        // (`network-manager.ts:349-352`, `362-369`). This is exactly what the
        // live handler serves today while NET-01's probe is deferred —
        // reference-faithful, never an over-claimed LAN URL.
        let fw = FirewallInfo {
            platform: FirewallPlatform::LinuxUfw,
            active: true,
        };
        let status = build_network_status(NetworkStatusInputs {
            configured: false,
            network_host: "127.0.0.1",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.1.20".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: None,
            wsl_forwarding_disabled_by_env: false,
            token: "t",
        });
        assert_eq!(status["remoteAccessRequested"], json!(true));
        assert_eq!(status["remoteAccessEnabled"], json!(false));
        assert_eq!(status["firewall"]["portOpen"], Value::Null);
        assert_eq!(status["accessUrl"], json!("http://localhost:3001/?token=t"));
    }

    #[test]
    fn share_url_uses_lan_ip_on_wsl2_when_requested_and_probe_unknown() {
        // The WSL2-unknown branch (`network-manager.ts:362-369` + `371-372`):
        // WSL2 LAN reachability is a portproxy question, not a firewall one,
        // so an unknown probe (env opt-out unset) still advertises the LAN URL.
        let fw = wsl2_inactive();
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "0.0.0.0",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.3.50".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: None,
            wsl_forwarding_disabled_by_env: false,
            token: "tok",
        });
        // Requested via the configured 0.0.0.0 host — the host check
        // (`network-access.ts:8-10`) precedes the wsl2 early-false.
        assert_eq!(status["remoteAccessRequested"], json!(true));
        // Unknown probe: not enabled, but also not a repair (portOpen null,
        // not false).
        assert_eq!(status["remoteAccessEnabled"], json!(false));
        assert_eq!(status["remoteAccessNeedsRepair"], json!(false));
        assert_eq!(
            status["accessUrl"],
            json!("http://192.168.3.50:3001/?token=tok")
        );
    }

    #[test]
    fn share_url_stays_loopback_on_wsl2_unknown_probe_when_forwarding_disabled_by_env() {
        // Same WSL2-unknown inputs but with the env opt-out: the share route
        // stays off and the URL degrades to loopback.
        let fw = wsl2_inactive();
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "0.0.0.0",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.3.50".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: None,
            wsl_forwarding_disabled_by_env: true,
            token: "tok",
        });
        assert_eq!(status["remoteAccessEnabled"], json!(false));
        assert_eq!(
            status["accessUrl"],
            json!("http://localhost:3001/?token=tok")
        );
    }

    #[test]
    fn access_url_percent_encodes_token_and_embeds_the_raw_secret_nowhere() {
        // NET-03 safety at the server layer: a query-hostile token goes out
        // percent-encoded INSIDE accessUrl (a raw `&`/`=` would corrupt the
        // URL's own query string) and appears nowhere else in the serialized
        // status payload.
        let token = "a b+c/d=&e";
        let fw = FirewallInfo {
            platform: FirewallPlatform::Windows,
            active: false,
        };
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "0.0.0.0",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.1.50".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: Some(true),
            wsl_forwarding_disabled_by_env: false,
            token,
        });
        assert_eq!(
            status["accessUrl"],
            json!("http://192.168.1.50:3001/?token=a%20b%2Bc%2Fd%3D%26e")
        );
        let wire = status.to_string();
        assert!(
            !wire.contains(token),
            "raw token leaked into status payload: {wire}"
        );
    }

    // ---- NET-05: POST /api/network/configure-firewall ---------------------

    #[test]
    fn parse_body_defaults_and_strict_schema() {
        // Empty body (Express `req.body ?? {}`) and `{}` both parse to defaults.
        for body in [b"".as_slice(), b"   \n".as_slice(), b"{}".as_slice()] {
            let req = parse_configure_firewall_body(body).expect("empty body parses");
            assert!(!req.confirm_elevation);
            assert_eq!(req.confirmation_token, None);
        }
        // Valid full body.
        let req = parse_configure_firewall_body(
            br#"{"confirmElevation": true, "confirmationToken": "abc"}"#,
        )
        .expect("valid body parses");
        assert!(req.confirm_elevation);
        assert_eq!(req.confirmation_token.as_deref(), Some("abc"));
        // Token without confirmation is still schema-valid (`confirmationToken`
        // is independently optional).
        let req = parse_configure_firewall_body(br#"{"confirmationToken": "abc"}"#).unwrap();
        assert!(!req.confirm_elevation);

        // 400s: non-object, non-JSON, unknown key (`.strict()`),
        // `confirmElevation` not literal `true`, empty `confirmationToken`.
        let bad_bodies: &[&[u8]] = &[
            b"[]",
            b"\"x\"",
            b"not json",
            br#"{"wat": 1}"#,
            br#"{"confirmElevation": false}"#, // z.literal(true)
            br#"{"confirmElevation": "yes"}"#,
            br#"{"confirmationToken": ""}"#, // z.string().min(1)
            br#"{"confirmationToken": 7}"#,
        ];
        for body in bad_bodies {
            assert!(
                parse_configure_firewall_body(body).is_err(),
                "must 400: {body:?}"
            );
        }
    }

    #[test]
    fn resolve_pre_plan_truth_table() {
        // Remote access off -> REMOTE_ACCESS_DISABLED (`network-router.ts:268-270`).
        assert_eq!(
            resolve_pre_plan(false, FirewallPlatform::Wsl2, None, &[]),
            ConfigureFirewallAction::None {
                method: "none",
                message: "Remote access is not enabled",
            }
        );
        // WSL2: portOpen true -> NO_CONFIGURATION_CHANGES_REQUIRED; otherwise
        // the live plan compute (`network-router.ts:273-284`). The deferred
        // probe feeds None, so wsl2 always reaches the plan compute here.
        assert_eq!(
            resolve_pre_plan(true, FirewallPlatform::Wsl2, Some(true), &[]),
            ConfigureFirewallAction::None {
                method: "none",
                message: "No configuration changes required",
            }
        );
        assert_eq!(
            resolve_pre_plan(true, FirewallPlatform::Wsl2, None, &[]),
            ConfigureFirewallAction::ComputeWsl2Plan
        );
        // Windows: no firewall -> none; portOpen true -> none; else the
        // elevated native-Windows repair — NET-05's documented deferral.
        assert_eq!(
            resolve_pre_plan(true, FirewallPlatform::Windows, None, &[]),
            ConfigureFirewallAction::None {
                method: "none",
                message: "No firewall detected",
            }
        );
        assert_eq!(
            resolve_pre_plan(
                true,
                FirewallPlatform::Windows,
                Some(true),
                &["netsh ...".to_string()]
            ),
            ConfigureFirewallAction::None {
                method: "none",
                message: "No configuration changes required",
            }
        );
        assert_eq!(
            resolve_pre_plan(
                true,
                FirewallPlatform::Windows,
                None,
                &["netsh ...".to_string()]
            ),
            ConfigureFirewallAction::Deferred
        );
        // Linux/macOS: no firewall -> none; else the non-elevated hint
        // (`network-router.ts:312-319`, commands joined with ` && `).
        assert_eq!(
            resolve_pre_plan(true, FirewallPlatform::LinuxUfw, None, &[]),
            ConfigureFirewallAction::None {
                method: "none",
                message: "No firewall detected",
            }
        );
        assert_eq!(
            resolve_pre_plan(
                true,
                FirewallPlatform::LinuxUfw,
                None,
                &["ufw allow 3001".to_string(), "ufw reload".to_string()]
            ),
            ConfigureFirewallAction::Terminal {
                command: "ufw allow 3001 && ufw reload".to_string(),
            }
        );
    }

    #[test]
    fn wsl2_plan_action_maps_the_plan_ladder() {
        use freshell_platform::port_forward::ScriptKind;
        assert_eq!(
            wsl2_plan_action(&WslPortForwardingPlan::Error("boom".into())),
            ConfigureFirewallAction::Error("boom".to_string())
        );
        for plan in [
            WslPortForwardingPlan::NotWsl2,
            WslPortForwardingPlan::Disabled,
            WslPortForwardingPlan::Noop { wsl_ip: "x".into() },
        ] {
            assert_eq!(
                wsl2_plan_action(&plan),
                ConfigureFirewallAction::None {
                    method: "none",
                    message: "No configuration changes required",
                }
            );
        }
        assert_eq!(
            wsl2_plan_action(&WslPortForwardingPlan::Ready {
                wsl_ip: "x".into(),
                script_kind: ScriptKind::Full,
                script: "S".into(),
            }),
            ConfigureFirewallAction::Wsl2Confirmable {
                script: "S".to_string()
            }
        );
    }

    // ---- NET-05: the gated confirm + elevated execute ----------------------

    use freshell_platform::port_forward::NETSH_PATH;
    use freshell_platform::{CommandOutput, FakeCommandRunner, MapEnv};

    const WSL_POWERSHELL: &str = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

    /// Post-repair READ-ONLY reads for port 3001: the portproxy rule and the
    /// FreshellLANAccess firewall rule are both present -> the recomputed plan
    /// is `Noop` -> verification passes.
    fn repaired_read_runner() -> FakeCommandRunner {
        FakeCommandRunner::new()
            .on(
                "ip",
                &["eth0"],
                CommandOutput::success("    inet 172.30.149.249/20 scope global eth0\n"),
            )
            .on(
                NETSH_PATH,
                &["portproxy", "show"],
                CommandOutput::success(
                    "Listen on ipv4:             Connect to ipv4:\r\n\r\n\
Address         Port        Address         Port\r\n\
--------------- ----------  --------------- ----------\r\n\
0.0.0.0         3001        172.30.149.249  3001\r\n",
                ),
            )
            .on(
                NETSH_PATH,
                &["name=FreshellLANAccess"],
                CommandOutput::success("Rule Name: FreshellLANAccess\r\nLocalPort: 3001\r\n"),
            )
    }

    /// Pre-repair READ-ONLY reads: nothing configured -> the recomputed plan is
    /// still `Ready` -> verification fails.
    fn unrepaired_read_runner() -> FakeCommandRunner {
        FakeCommandRunner::new()
            .on(
                "ip",
                &["eth0"],
                CommandOutput::success("    inet 172.30.149.249/20 scope global eth0\n"),
            )
            .on(
                NETSH_PATH,
                &["portproxy", "show"],
                CommandOutput::success(
                    "Listen on ipv4:             Connect to ipv4:\r\n\r\n\
Address         Port        Address         Port\r\n\
--------------- ----------  --------------- ----------\r\n",
                ),
            )
            .on(
                NETSH_PATH,
                &["name=FreshellLANAccess"],
                CommandOutput::failure(1, "No rules match the specified criteria.\r\n", ""),
            )
    }

    #[test]
    fn confirm_phase1_issues_token_and_never_spawns() {
        let home = tempfile::tempdir().unwrap();
        let managed = managed_wsl_ports_path(home.path());
        let gate = Mutex::new(ConfirmationGate::new());
        let spawn = FakeCommandRunner::new().with_default(CommandOutput::success(""));

        let (code, body) = confirm_and_execute_wsl2_repair(
            &gate,
            false,
            None,
            "TOKEN-1",
            "SCRIPT",
            &MapEnv::new(),
            &spawn,
            &repaired_read_runner(),
            &managed,
            &[3001],
        );
        assert_eq!(code, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "method": "confirmation-required",
                "title": "Administrator approval required",
                "body": "To complete this, you will need to accept the Windows administrator prompt on the next screen.",
                "confirmLabel": "Continue",
                "confirmationToken": "TOKEN-1",
            })
        );
        assert_eq!(spawn.call_count(), 0, "phase 1 must not elevate");
        assert!(
            !managed.exists(),
            "nothing persisted before a confirmed run"
        );
        assert!(!gate.lock().unwrap().is_repair_in_flight());

        // A confirm with a WRONG token re-issues a fresh token, still no spawn.
        let (code, body) = confirm_and_execute_wsl2_repair(
            &gate,
            true,
            Some("WRONG"),
            "TOKEN-2",
            "SCRIPT",
            &MapEnv::new(),
            &spawn,
            &repaired_read_runner(),
            &managed,
            &[3001],
        );
        assert_eq!(code, StatusCode::OK);
        assert_eq!(body["confirmationToken"], json!("TOKEN-2"));
        assert_eq!(spawn.call_count(), 0);
    }

    #[test]
    fn confirmed_repair_spawns_verifies_persists_and_releases() {
        let home = tempfile::tempdir().unwrap();
        let managed = managed_wsl_ports_path(home.path());
        let gate = Mutex::new(ConfirmationGate::new());
        let spawn = FakeCommandRunner::new().with_default(CommandOutput::success(""));

        // Phase 1.
        let (_, issued) = confirm_and_execute_wsl2_repair(
            &gate,
            false,
            None,
            "TOKEN-1",
            "SCRIPT",
            &MapEnv::new(),
            &spawn,
            &repaired_read_runner(),
            &managed,
            &[3001],
        );
        let token = issued["confirmationToken"].as_str().unwrap().to_string();

        // Phase 2 with the matching token.
        let (code, body) = confirm_and_execute_wsl2_repair(
            &gate,
            true,
            Some(&token),
            "TOKEN-2",
            "SCRIPT",
            &MapEnv::new(),
            &spawn,
            &repaired_read_runner(),
            &managed,
            &[3001],
        );
        assert_eq!(code, StatusCode::OK);
        assert_eq!(body, json!({ "method": "wsl2", "status": "started" }));

        // Exactly one elevated dispatch, through the WSL powershell path,
        // carrying the byte-escaped elevated wrapper around the plan script.
        assert_eq!(spawn.call_count(), 1);
        let (cmd, args) = spawn.calls().into_iter().next().unwrap();
        assert_eq!(cmd, WSL_POWERSHELL);
        assert!(args
            .iter()
            .any(|a| a.contains("Start-Process powershell -Verb RunAs")));
        assert!(args.iter().any(|a| a.contains("SCRIPT")));

        // Post-run verification passed, so the managed-ports state file was
        // persisted (byte-exact `JSON.stringify({ports}, null, 2)`).
        assert_eq!(
            std::fs::read_to_string(&managed).unwrap(),
            "{\n  \"ports\": [\n    3001\n  ]\n}"
        );
        // The in-flight lock was released (a subsequent repair can proceed).
        assert!(!gate.lock().unwrap().is_repair_in_flight());
    }

    #[test]
    fn confirmed_repair_spawn_failure_reports_and_persists_nothing() {
        let home = tempfile::tempdir().unwrap();
        let managed = managed_wsl_ports_path(home.path());
        let gate = Mutex::new(ConfirmationGate::new());
        gate.lock()
            .unwrap()
            .issue_confirmation(ConfirmationAction::Wsl2Repair, "T");
        // Spawn fails (UAC declined / powershell missing).
        let spawn = FakeCommandRunner::new().with_default(CommandOutput::spawn_failure("no"));

        let (code, body) = confirm_and_execute_wsl2_repair(
            &gate,
            true,
            Some("T"),
            "TOKEN-2",
            "SCRIPT",
            &MapEnv::new(),
            &spawn,
            &repaired_read_runner(),
            &managed,
            &[3001],
        );
        assert_eq!(code, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, json!({ "error": "WSL2 port forwarding failed" }));
        assert!(!managed.exists(), "no persist when the elevated run failed");
        assert!(!gate.lock().unwrap().is_repair_in_flight());
    }

    #[test]
    fn confirmed_repair_verification_failure_reports_and_persists_nothing() {
        let home = tempfile::tempdir().unwrap();
        let managed = managed_wsl_ports_path(home.path());
        let gate = Mutex::new(ConfirmationGate::new());
        gate.lock()
            .unwrap()
            .issue_confirmation(ConfirmationAction::Wsl2Repair, "T");
        let spawn = FakeCommandRunner::new().with_default(CommandOutput::success(""));

        // The elevated run "succeeds" but the re-read shows the plan still
        // Ready — the repair did not take (`verifyWslRepairSuccess` throw).
        let (code, body) = confirm_and_execute_wsl2_repair(
            &gate,
            true,
            Some("T"),
            "TOKEN-2",
            "SCRIPT",
            &MapEnv::new(),
            &spawn,
            &unrepaired_read_runner(),
            &managed,
            &[3001],
        );
        assert_eq!(code, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body,
            json!({ "error": "WSL2 port forwarding verification failed" })
        );
        assert!(!managed.exists(), "no persist when verification failed");
        assert!(!gate.lock().unwrap().is_repair_in_flight());
    }

    #[test]
    fn execute_wsl2_repair_script_reports_the_persist_flag() {
        let manage = |dir: &Path| managed_wsl_ports_path(dir);
        let spawn_ok = || FakeCommandRunner::new().with_default(CommandOutput::success(""));

        // Elevated run ok + post-run reads show the repair took -> verified +
        // persisted (`onSuccess` in the reference).
        let home = tempfile::tempdir().unwrap();
        let ok = execute_wsl2_repair_script(
            &MapEnv::new(),
            &spawn_ok(),
            &repaired_read_runner(),
            &manage(home.path()),
            &[3001],
            "SCRIPT",
        );
        assert!(ok.verification.is_ok());
        assert!(ok.persisted_managed_ports, "state file written on success");

        // Spawn failure -> the reference's `failedLog` error; verify nothing,
        // persist nothing (`catch` skips `onSuccess`).
        let home2 = tempfile::tempdir().unwrap();
        let fail = execute_wsl2_repair_script(
            &MapEnv::new(),
            &FakeCommandRunner::new(), // every call spawn-fails
            &repaired_read_runner(),
            &manage(home2.path()),
            &[3001],
            "SCRIPT",
        );
        assert_eq!(
            fail.verification,
            Err("WSL2 port forwarding failed".to_string())
        );
        assert!(!fail.persisted_managed_ports);

        // Repair did not take (plan still Ready on the re-read) -> the
        // `verifyWslRepairSuccess` throw; still nothing persisted.
        let home3 = tempfile::tempdir().unwrap();
        let not_taken = execute_wsl2_repair_script(
            &MapEnv::new(),
            &spawn_ok(),
            &unrepaired_read_runner(),
            &manage(home3.path()),
            &[3001],
            "SCRIPT",
        );
        assert_eq!(
            not_taken.verification,
            Err("WSL2 port forwarding verification failed".to_string())
        );
        assert!(!not_taken.persisted_managed_ports);
    }

    #[test]
    fn confirmed_repair_in_flight_is_409() {
        let home = tempfile::tempdir().unwrap();
        let managed = managed_wsl_ports_path(home.path());
        let gate = Mutex::new(ConfirmationGate::new());
        assert!(gate.lock().unwrap().try_acquire_repair_lock());
        let spawn = FakeCommandRunner::new().with_default(CommandOutput::success(""));

        let (code, body) = confirm_and_execute_wsl2_repair(
            &gate,
            false,
            None,
            "TOKEN-1",
            "SCRIPT",
            &MapEnv::new(),
            &spawn,
            &repaired_read_runner(),
            &managed,
            &[3001],
        );
        assert_eq!(code, StatusCode::CONFLICT);
        assert_eq!(
            body,
            json!({
                "error": "Firewall configuration already in progress",
                "method": "in-progress",
            })
        );
        assert_eq!(spawn.call_count(), 0);
    }

    // ---- NET-05: the route itself (in-process, READ-ONLY paths) ------------

    fn test_network_state(
        fw: FirewallInfo,
        settings_host: NetworkHost,
        effective_host: &str,
    ) -> NetworkState {
        let facts = OnceCell::new();
        facts
            .set(LiveNetworkFacts {
                firewall: fw,
                lan_ips: Vec::new(),
                hostname: "testhost".to_string(),
            })
            .expect("fresh OnceCell");
        let mut settings = crate::settings::default_server_settings();
        settings.network.configured = true;
        settings.network.host = settings_host;
        NetworkState {
            auth_token: Arc::new("tok".to_string()),
            settings: Arc::new(settings),
            effective_host: Arc::new(effective_host.to_string()),
            port: 3001,
            facts: Arc::new(facts),
            gate: Arc::new(Mutex::new(ConfirmationGate::new())),
        }
    }

    async fn post_configure_firewall(
        state: NetworkState,
        authed: bool,
        body: &'static str,
    ) -> (StatusCode, Value) {
        use tower::ServiceExt;
        let mut req = axum::http::Request::builder()
            .method("POST")
            .uri("/api/network/configure-firewall")
            .header("content-type", "application/json");
        if authed {
            req = req.header("x-auth-token", "tok");
        }
        let resp = router(state)
            .oneshot(req.body(axum::body::Body::from(body)).unwrap())
            .await
            .unwrap();
        let code = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (code, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn route_rejects_unauthenticated() {
        let state = test_network_state(wsl2_inactive(), NetworkHost::Loopback, "127.0.0.1");
        let (code, body) = post_configure_firewall(state, false, "{}").await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        assert_eq!(body, json!({ "error": "Unauthorized" }));
    }

    #[tokio::test]
    async fn route_loopback_boot_is_remote_access_disabled_none() {
        // Loopback bind: remote access not requested, so the route short-
        // circuits BEFORE any WSL2 plan compute (no live netsh reads).
        let state = test_network_state(wsl2_inactive(), NetworkHost::Loopback, "127.0.0.1");
        let (code, body) = post_configure_firewall(state, true, "{}").await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(
            body,
            json!({ "method": "none", "message": "Remote access is not enabled" })
        );
    }

    #[tokio::test]
    async fn route_linux_active_firewall_returns_the_terminal_hint() {
        // Non-WSL, non-Windows with an active firewall + requested remote
        // access: the non-elevated hint branch (`network-router.ts:312-319`),
        // fully in-process (suggested commands are golden strings only).
        let fw = FirewallInfo {
            platform: FirewallPlatform::LinuxUfw,
            active: true,
        };
        let state = test_network_state(fw, NetworkHost::AllInterfaces, "0.0.0.0");
        let (code, body) = post_configure_firewall(state, true, "{}").await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "method": "terminal",
                "command": firewall_commands(FirewallPlatform::LinuxUfw, &[3001]).join(" && "),
            })
        );
    }

    #[tokio::test]
    async fn route_invalid_body_is_400_after_auth() {
        let state = test_network_state(wsl2_inactive(), NetworkHost::Loopback, "127.0.0.1");
        let (code, body) =
            post_configure_firewall(state, true, r#"{"confirmElevation": false}"#).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], json!("Invalid request"));
    }

    #[tokio::test]
    async fn route_in_flight_precheck_is_409() {
        let state = test_network_state(wsl2_inactive(), NetworkHost::Loopback, "127.0.0.1");
        assert!(state.gate.lock().unwrap().try_acquire_repair_lock());
        let (code, body) = post_configure_firewall(state.clone(), true, "{}").await;
        assert_eq!(code, StatusCode::CONFLICT);
        assert_eq!(body["method"], json!("in-progress"));
        state.gate.lock().unwrap().release_repair_lock();
    }
}
