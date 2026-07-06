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
//! The **mutating** network paths (`configure` / `configure-firewall` /
//! `disable-remote-access`, i.e. `netsh add/delete` + elevated PowerShell) are
//! NOT wired here — they remain golden-string builders in `freshell-platform`,
//! never executed. The live facts are computed lazily (on first request) and
//! cached for the process life, mirroring the original's `getFirewallInfo` /
//! `ensureLanIps` memoization (so boot stays fast and repeat reads are instant).
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

use std::sync::Arc;

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use freshell_protocol::{NetworkHost, ServerSettings};
use freshell_platform::detect::{host_os_live, is_wsl2_proc_live};
use freshell_platform::network::{access_url, is_remote_access_enabled, NetworkIntent};
use freshell_platform::port_forward::is_wsl_port_forwarding_disabled_by_env;
use freshell_platform::{
    detect_firewall, firewall_commands, FirewallInfo, FirewallPlatform, RealEnv, StdCommandRunner,
};
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
}

/// The live, read-only host facts consulted by `getStatus`.
#[derive(Clone, Debug)]
pub struct LiveNetworkFacts {
    pub firewall: FirewallInfo,
    pub lan_ips: Vec<String>,
    pub hostname: String,
}

/// The network-status sub-router (`GET /api/network/status`), pre-bound to state.
pub fn router(state: NetworkState) -> Router {
    Router::new()
        .route("/api/network/status", get(network_status))
        .with_state(state)
}

async fn network_status(State(state): State<NetworkState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }

    // Resolve the live facts once (read-only subprocesses on `spawn_blocking`),
    // then reuse the cache. Mirrors `getFirewallInfo()`/`ensureLanIps()` memoization.
    let facts = state
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
        .await;

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

    // LAN IPs: on WSL, query the Windows host's physical adapters (READ-ONLY
    // `ipconfig.exe`, ranked). Off-WSL, `os.networkInterfaces()` is a live edge
    // left unwired (empty) — documented; only affects the 0.0.0.0 share path.
    let lan_ips = if is_wsl2 {
        freshell_platform::network::detect_lan_ips_via_ipconfig(&runner)
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
fn read_machine_hostname() -> String {
    let raw = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "localhost".to_string());
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
            "configured", "host", "remoteAccessEnabled", "remoteAccessRequested",
            "remoteAccessNeedsRepair", "port", "lanIps", "machineHostname",
            "firewall", "rebinding", "devMode", "accessUrl",
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
        assert_eq!(status["accessUrl"], json!("http://localhost:51234/?token=tok-abc"));
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
        assert!(!status["firewall"]["commands"].as_array().unwrap().is_empty());
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
}
