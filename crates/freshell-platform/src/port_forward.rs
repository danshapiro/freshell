//! WSL port-forward: `netsh interface portproxy` + the `FreshellLANAccess`
//! firewall companion rule, plans and idempotency.
//!
//! Identical port of `server/wsl-port-forward.ts` (`platform-glue.md` §4).
//!
//! ## Byte-load-bearing escaping (P21)
//!
//! The script builders here emit the **raw** form containing `2>\$null` (a
//! literal backslash-dollar). freshell writes this because the script first
//! survives `sh` interpolation, then is passed through
//! [`normalize_script_for_elevated_powershell`] (`\$` → `$`) *right before*
//! elevation — yielding `2>$null` for PowerShell. Both forms are golden-tested.
//!
//! The rule name `FreshellLANAccess` is deliberately **space-free** (avoids
//! nested-quote escaping) and the WSL firewall rule uses lower-case
//! `protocol=tcp` (contrast the native-Windows `protocol=TCP`, [`crate::firewall`]).
//!
//! ## Safety
//!
//! `portproxy`/`firewall` `add`/`delete` are elevated & mutating. This module
//! only ever **builds** those command strings; the READ-ONLY `show` reads
//! (`get_existing_*`, [`get_wsl_ip`]) are the only things run against a live
//! host, and even those go through the injected [`CommandRunner`].

use std::collections::BTreeMap;

use crate::{CommandRunner, Env};

/// Hardcoded full path — bare `netsh` is not on the WSL PATH (`wsl-port-forward.ts:8`).
pub const NETSH_PATH: &str = "/mnt/c/Windows/System32/netsh.exe";
/// `DEFAULT_PORT` (`wsl-port-forward.ts:9`).
pub const DEFAULT_PORT: u16 = 3001;

/// `PortProxyRule` (`wsl-port-forward.ts:112-115`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortProxyRule {
    pub connect_address: String,
    pub connect_port: u16,
}

/// `scriptKind` (`wsl-port-forward.ts:385`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptKind {
    Full,
    FirewallOnly,
}

impl ScriptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScriptKind::Full => "full",
            ScriptKind::FirewallOnly => "firewall-only",
        }
    }
}

/// `WslPortForwardingPlan` (`wsl-port-forward.ts:377-387`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WslPortForwardingPlan {
    NotWsl2,
    Disabled,
    Error(String),
    Noop { wsl_ip: String },
    Ready { wsl_ip: String, script_kind: ScriptKind, script: String },
}

/// `WslPortForwardingTeardownPlan` (`wsl-port-forward.ts:389-394`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WslPortForwardingTeardownPlan {
    NotWsl2,
    Disabled,
    Error(String),
    Noop,
    Ready { script: String },
}

// ---------------------------------------------------------------------------
// Small numeric / string helpers
// ---------------------------------------------------------------------------

/// JS `Number.parseInt(s, 10)` on a leading integer: skip leading whitespace,
/// optional sign, then digits; stop at the first non-digit. `None` == `NaN`.
pub(crate) fn parse_int_prefix(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut sign: i64 = 1;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        if bytes[i] == b'-' {
            sign = -1;
        }
        i += 1;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    s[start..i].parse::<i64>().ok().map(|n| sign * n)
}

/// `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` (`wsl-port-forward.ts:7`).
fn is_ipv4_shape(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| {
            !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit())
        })
}

/// `Array.from(new Set(...))` preserving first-seen insertion order.
fn unique_preserving_order(items: impl IntoIterator<Item = u16>) -> Vec<u16> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for x in items {
        if seen.insert(x) {
            out.push(x);
        }
    }
    out
}

/// `normalizeManagedPorts` (`wsl-port-forward.ts:63-67`): dedupe, keep `1..=65535`,
/// sort ascending.
pub fn normalize_managed_ports(ports: &[u16]) -> Vec<u16> {
    let mut set = std::collections::BTreeSet::new();
    for &p in ports {
        if p >= 1 {
            set.insert(p);
        }
    }
    set.into_iter().collect()
}

// ---------------------------------------------------------------------------
// Parsers (`show` output) — READ-ONLY
// ---------------------------------------------------------------------------

/// `parsePortProxyRules` (`wsl-port-forward.ts:121-139`): keep rows whose listen
/// address is `0.0.0.0`, mapping `listenPort -> { connectAddress, connectPort }`.
///
/// Reproduces `^([\d.]+)\s+(\d+)\s+([\d.]+)\s+(\d+)` — anchored at column 0, so a
/// line with leading whitespace does not match.
pub fn parse_port_proxy_rules(output: &str) -> BTreeMap<u16, PortProxyRule> {
    let mut rules = BTreeMap::new();
    for line in output.split('\n') {
        let bytes = line.as_bytes();
        // `^([\d.]+)` — first char must be a digit or dot (no leading space).
        if bytes.is_empty() || !(bytes[0].is_ascii_digit() || bytes[0] == b'.') {
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(f0), Some(f1), Some(f2), Some(f3)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let is_ip_chars = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit() || b == b'.');
        let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        if !is_ip_chars(f0) || !all_digits(f1) || !is_ip_chars(f2) || !all_digits(f3) {
            continue;
        }
        if f0 != "0.0.0.0" {
            continue;
        }
        let (Ok(listen_port), Ok(connect_port)) = (f1.parse::<u16>(), f3.parse::<u16>()) else {
            continue;
        };
        rules.insert(
            listen_port,
            PortProxyRule { connect_address: f2.to_string(), connect_port },
        );
    }
    rules
}

/// `parseFirewallRulePorts` (`wsl-port-forward.ts:238-252`): every port on a
/// `LocalPort:` line (comma-split). Returns first-seen insertion order, deduped
/// (matches the reference `Set`'s iteration order, which feeds cleanup ordering).
pub fn parse_firewall_rule_ports(output: &str) -> Vec<u16> {
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for line in output.split('\n') {
        let lower = line.to_ascii_lowercase();
        if let Some(idx) = lower.find("localport:") {
            let rest = &line[idx + "localport:".len()..];
            let trimmed = rest.trim();
            if trimmed.is_empty() {
                continue; // `(.+)` requires >= 1 non-whitespace char
            }
            for piece in trimmed.split(',') {
                if let Some(n) = parse_int_prefix(piece.trim()) {
                    if (0..=u16::MAX as i64).contains(&n) {
                        let p = n as u16;
                        if seen.insert(p) {
                            out.push(p);
                        }
                    }
                }
            }
        }
    }
    out
}

/// `isMissingFirewallRuleResult` (`wsl-port-forward.ts:106-110`): the netsh
/// `show rule` "rule absent" signature — exit 1, empty stderr, zero parsed ports.
pub fn is_missing_firewall_rule_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> bool {
    exit_code == Some(1) && stderr.trim().is_empty() && parse_firewall_rule_ports(stdout).is_empty()
}

// ---------------------------------------------------------------------------
// Port selection / env kill-switch
// ---------------------------------------------------------------------------

/// `getRequiredPorts` (`wsl-port-forward.ts:173-192`): `PORT` env (validated
/// `1..=65535`) else `3001`; the dev companion port only when
/// `NODE_ENV !== 'production'`. Server port first, then dev port (deduped).
pub fn get_required_ports(env: &dyn Env, dev_port: Option<u16>) -> Vec<u16> {
    let parsed = if env.truthy("PORT") {
        parse_int_prefix(&env.get("PORT").unwrap_or_default())
    } else {
        Some(DEFAULT_PORT as i64)
    };
    let server_port = match parsed {
        Some(n) if (1..=65535).contains(&n) => n as u16,
        _ => DEFAULT_PORT,
    };

    let mut ports = vec![server_port];
    let not_production = env.get("NODE_ENV").as_deref() != Some("production");
    if not_production {
        if let Some(dp) = dev_port {
            if (1..=65535).contains(&(dp as i64)) && !ports.contains(&dp) {
                ports.push(dp);
            }
        }
    }
    ports
}

/// `isWslPortForwardingDisabledByEnv` (`wsl-port-forward.ts:371-375`).
pub fn is_wsl_port_forwarding_disabled_by_env(env: &dyn Env) -> bool {
    match env.get("FRESHELL_DISABLE_WSL_PORT_FORWARD") {
        Some(v) if !v.is_empty() => {
            matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes")
        }
        _ => false,
    }
}

/// `normalizeScriptForElevatedPowerShell` (`wsl-port-forward.ts:396-398`).
pub fn normalize_script_for_elevated_powershell(script: &str) -> String {
    script.replace("\\$", "$")
}

// ---------------------------------------------------------------------------
// Idempotency predicates
// ---------------------------------------------------------------------------

/// `needsFirewallUpdate` (`wsl-port-forward.ts:278-283`): any required port
/// absent from the existing rule. Extra ports tolerated (avoids needless UAC).
pub fn needs_firewall_update(required_ports: &[u16], existing_ports: &[u16]) -> bool {
    required_ports.iter().any(|p| !existing_ports.contains(p))
}

/// `needsPortForwardingUpdate` (`wsl-port-forward.ts:302-317`): any required
/// port missing, pointing at the wrong IP, or the wrong connect port.
pub fn needs_port_forwarding_update(
    wsl_ip: &str,
    required_ports: &[u16],
    existing_rules: &BTreeMap<u16, PortProxyRule>,
) -> bool {
    for &port in required_ports {
        match existing_rules.get(&port) {
            None => return true,
            Some(rule) => {
                if rule.connect_address != wsl_ip || rule.connect_port != port {
                    return true;
                }
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Script builders (RAW `\$` form — normalize before elevation)
// ---------------------------------------------------------------------------

fn join_ports(ports: &[u16]) -> String {
    ports.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",")
}

/// `buildFirewallOnlyScript` (`wsl-port-forward.ts:289-296`).
pub fn build_firewall_only_script(ports: &[u16]) -> String {
    [
        "netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null".to_string(),
        format!(
            "netsh advfirewall firewall add rule name=FreshellLANAccess \
dir=in action=allow protocol=tcp localport={} profile=private",
            join_ports(ports)
        ),
    ]
    .join("; ")
}

/// `buildPortForwardingScript` (`wsl-port-forward.ts:324-351`).
///
/// Deletes (deduped `cleanup_ports`) then adds (raw `ports`), then the
/// delete-then-add firewall rule. `cleanup_ports` defaults to `ports`.
pub fn build_port_forwarding_script(wsl_ip: &str, ports: &[u16], cleanup_ports: &[u16]) -> String {
    let mut cmds: Vec<String> = Vec::new();

    for port in unique_preserving_order(cleanup_ports.iter().copied()) {
        cmds.push(format!(
            "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport={port} 2>\\$null"
        ));
    }
    for &port in ports {
        cmds.push(format!(
            "netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 \
listenport={port} connectaddress={wsl_ip} connectport={port}"
        ));
    }
    cmds.push("netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null".to_string());
    cmds.push(format!(
        "netsh advfirewall firewall add rule name=FreshellLANAccess \
dir=in action=allow protocol=tcp localport={} profile=private",
        join_ports(ports)
    ));

    cmds.join("; ")
}

/// `buildPortForwardingTeardownScript` (`wsl-port-forward.ts:357-369`).
pub fn build_port_forwarding_teardown_script(ports: &[u16]) -> String {
    let mut cmds: Vec<String> = Vec::new();
    for port in unique_preserving_order(ports.iter().copied()) {
        cmds.push(format!(
            "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport={port} 2>\\$null"
        ));
    }
    cmds.push("netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null".to_string());
    cmds.join("; ")
}

// ---------------------------------------------------------------------------
// Plan builders (pure)
// ---------------------------------------------------------------------------

/// `getLegacyOwnedPortProxyPorts` (`wsl-port-forward.ts:400-408`).
fn get_legacy_owned_port_proxy_ports(
    required_ports: &[u16],
    known_owned_ports: &[u16],
    existing_rules: &BTreeMap<u16, PortProxyRule>,
) -> Vec<u16> {
    let required: std::collections::BTreeSet<u16> = required_ports.iter().copied().collect();
    normalize_managed_ports(known_owned_ports)
        .into_iter()
        .filter(|p| !required.contains(p) && existing_rules.contains_key(p))
        .collect()
}

/// `getStaleFirewallPorts` (`wsl-port-forward.ts:410-416`) — preserves the
/// existing-firewall-ports order (feeds cleanup ordering).
fn get_stale_firewall_ports(required_ports: &[u16], existing_firewall_ports: &[u16]) -> Vec<u16> {
    let required: std::collections::BTreeSet<u16> = required_ports.iter().copied().collect();
    existing_firewall_ports
        .iter()
        .copied()
        .filter(|p| !required.contains(p))
        .collect()
}

/// `getStaleManagedPortProxyPorts` (`wsl-port-forward.ts:418-426`).
fn get_stale_managed_port_proxy_ports(
    required_ports: &[u16],
    managed_ports: &[u16],
    existing_rules: &BTreeMap<u16, PortProxyRule>,
) -> Vec<u16> {
    let required: std::collections::BTreeSet<u16> = required_ports.iter().copied().collect();
    managed_ports
        .iter()
        .copied()
        .filter(|p| !required.contains(p) && existing_rules.contains_key(p))
        .collect()
}

/// `buildWslPortForwardingPlan` (`wsl-port-forward.ts:428-475`) — the pure plan
/// logic (P20/P21). All IO (WSL IP, existing rules/ports, managed ports) is
/// resolved by the caller and injected.
#[allow(clippy::too_many_arguments)]
pub fn build_wsl_port_forwarding_plan(
    required_ports: &[u16],
    known_owned_ports: &[u16],
    wsl_ip: &str,
    existing_rules: &BTreeMap<u16, PortProxyRule>,
    existing_firewall_ports: &[u16],
    managed_ports: &[u16],
) -> WslPortForwardingPlan {
    let stale_firewall_ports = get_stale_firewall_ports(required_ports, existing_firewall_ports);
    let stale_managed = get_stale_managed_port_proxy_ports(required_ports, managed_ports, existing_rules);
    let stale_owned = unique_preserving_order(
        stale_firewall_ports
            .iter()
            .copied()
            .filter(|p| existing_rules.contains_key(p))
            .chain(stale_managed.iter().copied())
            .chain(get_legacy_owned_port_proxy_ports(required_ports, known_owned_ports, existing_rules)),
    );

    let ports_need_update =
        needs_port_forwarding_update(wsl_ip, required_ports, existing_rules) || !stale_owned.is_empty();
    let firewall_needs_update =
        needs_firewall_update(required_ports, existing_firewall_ports) || !stale_firewall_ports.is_empty();

    if !ports_need_update && !firewall_needs_update {
        return WslPortForwardingPlan::Noop { wsl_ip: wsl_ip.to_string() };
    }

    let script_kind = if ports_need_update { ScriptKind::Full } else { ScriptKind::FirewallOnly };
    let cleanup_ports = unique_preserving_order(
        required_ports
            .iter()
            .copied()
            .chain(stale_firewall_ports.iter().copied())
            .chain(stale_owned.iter().copied()),
    );
    let script = match script_kind {
        ScriptKind::Full => build_port_forwarding_script(wsl_ip, required_ports, &cleanup_ports),
        ScriptKind::FirewallOnly => build_firewall_only_script(required_ports),
    };

    WslPortForwardingPlan::Ready {
        wsl_ip: wsl_ip.to_string(),
        script_kind,
        script: normalize_script_for_elevated_powershell(&script),
    }
}

/// `buildWslPortForwardingTeardownPlan` (`wsl-port-forward.ts:477-501`).
pub fn build_wsl_port_forwarding_teardown_plan(
    required_ports: &[u16],
    known_owned_ports: &[u16],
    existing_rules: &BTreeMap<u16, PortProxyRule>,
    existing_firewall_ports: &[u16],
    managed_ports: &[u16],
) -> WslPortForwardingTeardownPlan {
    let teardown_ports = unique_preserving_order(
        required_ports
            .iter()
            .copied()
            .chain(existing_firewall_ports.iter().copied())
            .chain(managed_ports.iter().copied())
            .chain(get_legacy_owned_port_proxy_ports(&[], known_owned_ports, existing_rules)),
    );
    let has_relevant_port_proxy_rules = teardown_ports.iter().any(|p| existing_rules.contains_key(p));
    let has_freshell_firewall_rule = !existing_firewall_ports.is_empty();

    if !has_relevant_port_proxy_rules && !has_freshell_firewall_rule {
        return WslPortForwardingTeardownPlan::Noop;
    }

    WslPortForwardingTeardownPlan::Ready {
        script: normalize_script_for_elevated_powershell(&build_port_forwarding_teardown_script(
            &teardown_ports,
        )),
    }
}

// ---------------------------------------------------------------------------
// Runner-backed reads (READ-ONLY `show` / `ip` / `hostname`)
// ---------------------------------------------------------------------------

fn parse_eth0_ip(stdout: &str) -> Option<String> {
    // `/inet\s+([\d.]+)/` — "inet" then >=1 whitespace then a `[\d.]+` run.
    let bytes = stdout.as_bytes();
    let mut search_from = 0;
    while let Some(rel) = stdout[search_from..].find("inet") {
        let mut i = search_from + rel + "inet".len();
        // Require >= 1 whitespace immediately after "inet" (so "inet6" is skipped).
        if i < bytes.len() && bytes[i].is_ascii_whitespace() {
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            if i > start {
                let candidate = &stdout[start..i];
                if is_ipv4_shape(candidate) {
                    return Some(candidate.to_string());
                }
            }
        }
        search_from += rel + "inet".len();
    }
    None
}

fn parse_hostname_ip(stdout: &str) -> Option<String> {
    // `stdout.trim().split(/\s+/).filter(Boolean)` == `split_whitespace()`.
    stdout
        .split_whitespace()
        .find(|addr| is_ipv4_shape(addr) && !addr.starts_with("172.17."))
        .map(|s| s.to_string())
}

/// `getWslIpAsync` (`wsl-port-forward.ts:141-171`): `ip -4 addr show eth0`, else
/// `hostname -I` first non-`172.17.*` IPv4. READ-ONLY.
pub fn get_wsl_ip(runner: &dyn CommandRunner) -> Option<String> {
    let ip_out = runner.run("ip", &["-4", "addr", "show", "eth0"]);
    if ip_out.ok() {
        if let Some(ip) = parse_eth0_ip(&ip_out.stdout) {
            return Some(ip);
        }
    }
    let host_out = runner.run("hostname", &["-I"]);
    if host_out.ok() {
        return parse_hostname_ip(&host_out.stdout);
    }
    None
}

/// `getExistingPortProxyRulesAsync` (`wsl-port-forward.ts:221-232`): `None` on
/// query failure. READ-ONLY (`portproxy show v4tov4`).
pub fn get_existing_port_proxy_rules(
    runner: &dyn CommandRunner,
) -> Option<BTreeMap<u16, PortProxyRule>> {
    let out = runner.run(NETSH_PATH, &["interface", "portproxy", "show", "v4tov4"]);
    if out.ok() {
        Some(parse_port_proxy_rules(&out.stdout))
    } else {
        None
    }
}

/// `getExistingFirewallPortsAsync` (`wsl-port-forward.ts:254-270`): empty when
/// the rule is absent, `None` on query failure. READ-ONLY (`show rule name=…`).
pub fn get_existing_firewall_ports(runner: &dyn CommandRunner) -> Option<Vec<u16>> {
    let out = runner.run(
        NETSH_PATH,
        &["advfirewall", "firewall", "show", "rule", "name=FreshellLANAccess"],
    );
    if out.ok() {
        return Some(parse_firewall_rule_ports(&out.stdout));
    }
    if is_missing_firewall_rule_result(out.exit_code, &out.stdout, &out.stderr) {
        return Some(Vec::new());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, FakeCommandRunner, MapEnv};

    fn rule(addr: &str, port: u16) -> PortProxyRule {
        PortProxyRule { connect_address: addr.to_string(), connect_port: port }
    }

    // ---- script builder golden strings (P21) ------------------------------

    #[test]
    fn firewall_only_script_golden_raw_backslash() {
        assert_eq!(
            build_firewall_only_script(&[3001]),
            "netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null; \
netsh advfirewall firewall add rule name=FreshellLANAccess dir=in action=allow \
protocol=tcp localport=3001 profile=private"
        );
    }

    #[test]
    fn port_forwarding_script_golden_raw_backslash() {
        // Single required port, cleanup defaults to the same port set.
        let got = build_port_forwarding_script("172.30.149.249", &[3001], &[3001]);
        assert_eq!(
            got,
            "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=3001 2>\\$null; \
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3001 \
connectaddress=172.30.149.249 connectport=3001; \
netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null; \
netsh advfirewall firewall add rule name=FreshellLANAccess dir=in action=allow \
protocol=tcp localport=3001 profile=private"
        );
    }

    #[test]
    fn port_forwarding_script_multiport_and_distinct_cleanup() {
        let got = build_port_forwarding_script("10.0.0.5", &[3001, 3002], &[3001, 3002, 9999]);
        assert_eq!(
            got,
            "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=3001 2>\\$null; \
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=3002 2>\\$null; \
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=9999 2>\\$null; \
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3001 \
connectaddress=10.0.0.5 connectport=3001; \
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3002 \
connectaddress=10.0.0.5 connectport=3002; \
netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null; \
netsh advfirewall firewall add rule name=FreshellLANAccess dir=in action=allow \
protocol=tcp localport=3001,3002 profile=private"
        );
    }

    #[test]
    fn teardown_script_golden() {
        assert_eq!(
            build_port_forwarding_teardown_script(&[3001, 3001, 3002]),
            "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=3001 2>\\$null; \
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=3002 2>\\$null; \
netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null"
        );
    }

    #[test]
    fn normalize_unescapes_backslash_dollar_for_powershell() {
        let raw = build_firewall_only_script(&[3001]);
        assert!(raw.contains("2>\\$null"));
        let norm = normalize_script_for_elevated_powershell(&raw);
        assert!(norm.contains("2>$null"));
        assert!(!norm.contains("2>\\$null"));
    }

    // ---- parsers (against REAL netsh output shapes) -----------------------

    #[test]
    fn parse_portproxy_keeps_only_0000_listen() {
        // Transcribed from live `netsh interface portproxy show v4tov4`.
        let out = "\r\nListen on ipv4:             Connect to ipv4:\r\n\r\n\
Address         Port        Address         Port\r\n\
--------------- ----------  --------------- ----------\r\n\
127.0.0.1       8081        172.30.149.249  8081\r\n\
0.0.0.0         3001        172.30.149.249  3001\r\n";
        let rules = parse_port_proxy_rules(out);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules.get(&3001), Some(&rule("172.30.149.249", 3001)));
        assert!(!rules.contains_key(&8081)); // 127.0.0.1 listener filtered out
    }

    #[test]
    fn parse_firewall_ports_comma_split_and_dedup() {
        let out = "Rule Name: FreshellLANAccess\r\nLocalPort:   3001, 3002 ,3001\r\nRemotePort: Any\r\n";
        assert_eq!(parse_firewall_rule_ports(out), vec![3001, 3002]);
    }

    #[test]
    fn parse_firewall_ports_empty_when_no_rule() {
        assert!(parse_firewall_rule_ports("No rules match the specified criteria.\r\n").is_empty());
    }

    #[test]
    fn missing_firewall_rule_signature() {
        assert!(is_missing_firewall_rule_result(
            Some(1),
            "No rules match the specified criteria.\r\n",
            ""
        ));
        // exit 0 -> not "missing"
        assert!(!is_missing_firewall_rule_result(Some(0), "", ""));
        // non-empty stderr -> a real query failure, not "missing"
        assert!(!is_missing_firewall_rule_result(Some(1), "", "boom"));
    }

    // ---- port selection / kill-switch -------------------------------------

    #[test]
    fn required_ports_default_and_env() {
        assert_eq!(get_required_ports(&MapEnv::new(), None), vec![3001]);
        assert_eq!(get_required_ports(&MapEnv::new().with("PORT", "4000"), None), vec![4000]);
        // invalid PORT -> default
        assert_eq!(get_required_ports(&MapEnv::new().with("PORT", "abc"), None), vec![3001]);
        // out of range -> default
        assert_eq!(get_required_ports(&MapEnv::new().with("PORT", "70000"), None), vec![3001]);
    }

    #[test]
    fn required_ports_dev_only_non_production() {
        assert_eq!(get_required_ports(&MapEnv::new(), Some(5173)), vec![3001, 5173]);
        let prod = MapEnv::new().with("NODE_ENV", "production");
        assert_eq!(get_required_ports(&prod, Some(5173)), vec![3001]);
        // dev port equal to server port dedupes
        assert_eq!(get_required_ports(&MapEnv::new(), Some(3001)), vec![3001]);
    }

    #[test]
    fn kill_switch_values() {
        for v in ["1", "true", "yes", "TRUE", "Yes"] {
            let env = MapEnv::new().with("FRESHELL_DISABLE_WSL_PORT_FORWARD", v);
            assert!(is_wsl_port_forwarding_disabled_by_env(&env), "{v}");
        }
        assert!(!is_wsl_port_forwarding_disabled_by_env(&MapEnv::new()));
        assert!(!is_wsl_port_forwarding_disabled_by_env(
            &MapEnv::new().with("FRESHELL_DISABLE_WSL_PORT_FORWARD", "0")
        ));
    }

    // ---- plan logic (P20) -------------------------------------------------

    #[test]
    fn plan_noop_when_rule_and_firewall_correct() {
        let mut rules = BTreeMap::new();
        rules.insert(3001, rule("172.30.149.249", 3001));
        let plan = build_wsl_port_forwarding_plan(
            &[3001],
            &[3001],
            "172.30.149.249",
            &rules,
            &[3001],
            &[3001],
        );
        assert_eq!(plan, WslPortForwardingPlan::Noop { wsl_ip: "172.30.149.249".into() });
    }

    #[test]
    fn plan_full_when_portproxy_missing() {
        let rules = BTreeMap::new(); // nothing configured yet
        let plan = build_wsl_port_forwarding_plan(&[3001], &[3001], "172.30.149.249", &rules, &[], &[]);
        match plan {
            WslPortForwardingPlan::Ready { script_kind, script, wsl_ip } => {
                assert_eq!(script_kind, ScriptKind::Full);
                assert_eq!(wsl_ip, "172.30.149.249");
                assert!(script.contains("portproxy add"));
                assert!(script.contains("2>$null")); // normalized for PowerShell
                assert!(!script.contains("2>\\$null"));
            }
            other => panic!("expected Ready/full, got {other:?}"),
        }
    }

    #[test]
    fn plan_firewall_only_when_proxy_ok_but_firewall_missing() {
        let mut rules = BTreeMap::new();
        rules.insert(3001, rule("172.30.149.249", 3001));
        // firewall rule has no ports -> needs firewall update, proxy fine.
        let plan = build_wsl_port_forwarding_plan(&[3001], &[3001], "172.30.149.249", &rules, &[], &[]);
        match plan {
            WslPortForwardingPlan::Ready { script_kind, script, .. } => {
                assert_eq!(script_kind, ScriptKind::FirewallOnly);
                assert!(!script.contains("portproxy"));
                assert!(script.contains("firewall add rule name=FreshellLANAccess"));
            }
            other => panic!("expected Ready/firewall-only, got {other:?}"),
        }
    }

    #[test]
    fn plan_full_cleans_up_stale_owned_ports() {
        // Required 3001 correct, but a stale managed 4000 proxy rule exists.
        let mut rules = BTreeMap::new();
        rules.insert(3001, rule("172.30.149.249", 3001));
        rules.insert(4000, rule("172.30.149.249", 4000));
        let plan = build_wsl_port_forwarding_plan(
            &[3001],
            &[3001],
            "172.30.149.249",
            &rules,
            &[3001],   // firewall already has 3001
            &[4000],   // managed ports include stale 4000
        );
        match plan {
            WslPortForwardingPlan::Ready { script_kind, script, .. } => {
                assert_eq!(script_kind, ScriptKind::Full);
                // cleanup includes stale 4000 delete before the 3001 add
                assert!(script.contains("delete v4tov4 listenaddress=0.0.0.0 listenport=4000"));
            }
            other => panic!("expected Ready/full, got {other:?}"),
        }
    }

    #[test]
    fn teardown_plan_noop_when_nothing_present() {
        let rules = BTreeMap::new();
        assert_eq!(
            build_wsl_port_forwarding_teardown_plan(&[3001], &[3001], &rules, &[], &[]),
            WslPortForwardingTeardownPlan::Noop
        );
    }

    #[test]
    fn teardown_plan_ready_removes_rule_and_proxy() {
        let mut rules = BTreeMap::new();
        rules.insert(3001, rule("172.30.149.249", 3001));
        let plan = build_wsl_port_forwarding_teardown_plan(&[3001], &[3001], &rules, &[3001], &[]);
        match plan {
            WslPortForwardingTeardownPlan::Ready { script } => {
                assert!(script.contains("portproxy delete"));
                assert!(script.contains("firewall delete rule name=FreshellLANAccess"));
                assert!(script.contains("2>$null"));
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    // ---- WSL IP parsing ----------------------------------------------------

    #[test]
    fn parse_eth0_ip_from_ip_addr() {
        let out = "2: eth0: <BROADCAST> mtu 1500\n    inet 172.30.149.249/20 brd 172.30.159.255 scope global eth0\n";
        assert_eq!(parse_eth0_ip(out).as_deref(), Some("172.30.149.249"));
    }

    #[test]
    fn parse_eth0_ip_skips_inet6() {
        let out = "    inet6 fe80::215:5dff:fe? scope link\n    inet 10.0.0.4/24 scope global eth0\n";
        assert_eq!(parse_eth0_ip(out).as_deref(), Some("10.0.0.4"));
    }

    #[test]
    fn parse_hostname_ip_skips_docker() {
        assert_eq!(
            parse_hostname_ip("172.17.0.1 192.168.1.50 \n").as_deref(),
            Some("192.168.1.50")
        );
    }

    #[test]
    fn get_wsl_ip_prefers_eth0_then_hostname() {
        let eth0 = FakeCommandRunner::new().on(
            "ip",
            &["eth0"],
            CommandOutput::success("    inet 172.30.149.249/20 scope global eth0\n"),
        );
        assert_eq!(get_wsl_ip(&eth0).as_deref(), Some("172.30.149.249"));

        // eth0 fails -> hostname fallback
        let host = FakeCommandRunner::new()
            .on("ip", &["eth0"], CommandOutput::failure(1, "", "no eth0"))
            .on("hostname", &["-I"], CommandOutput::success("172.17.0.1 10.1.2.3\n"));
        assert_eq!(get_wsl_ip(&host).as_deref(), Some("10.1.2.3"));
    }

    // ---- runner-backed reads via fakes ------------------------------------

    #[test]
    fn existing_firewall_ports_missing_rule_is_empty_not_none() {
        let runner = FakeCommandRunner::new().on(
            NETSH_PATH,
            &["name=FreshellLANAccess"],
            CommandOutput::failure(1, "No rules match the specified criteria.\r\n", ""),
        );
        assert_eq!(get_existing_firewall_ports(&runner), Some(vec![]));
    }

    #[test]
    fn existing_firewall_ports_query_failure_is_none() {
        let runner = FakeCommandRunner::new().on(
            NETSH_PATH,
            &["name=FreshellLANAccess"],
            CommandOutput::spawn_failure("netsh missing"),
        );
        assert_eq!(get_existing_firewall_ports(&runner), None);
    }

    // ---- READ-ONLY live verification (skips off-WSL) ----------------------

    /// P18 (`LV? = yes`): the real `get_wsl_ip` via [`crate::StdCommandRunner`]
    /// (`ip -4 addr show eth0`). READ-ONLY; asserts IPv4 shape only.
    #[test]
    fn live_wsl_ip_readonly() {
        if !crate::detect::is_wsl2_proc_live() {
            eprintln!("SKIP live_wsl_ip_readonly: not WSL2");
            return;
        }
        let runner = crate::StdCommandRunner::default();
        match get_wsl_ip(&runner) {
            Some(ip) => {
                assert!(is_ipv4_shape(&ip), "expected IPv4 shape, got {ip:?}");
                eprintln!("LIVE get_wsl_ip (read-only) -> {ip}");
            }
            None => eprintln!("SKIP-ish: WSL IP not detectable on this host"),
        }
    }

    /// P19 (`LV? = yes`): the real `portproxy show v4tov4` + firewall `show rule`
    /// reads. READ-ONLY; asserts parse-shape only, never mutates.
    #[test]
    fn live_portproxy_and_firewall_show_readonly() {
        if !std::path::Path::new(NETSH_PATH).exists() {
            eprintln!("SKIP live_portproxy_and_firewall_show_readonly: {NETSH_PATH} absent");
            return;
        }
        let runner = crate::StdCommandRunner::default();

        let rules = get_existing_port_proxy_rules(&runner).expect("portproxy show should succeed");
        for (listen, r) in &rules {
            assert!(*listen >= 1);
            assert!(is_ipv4_shape(&r.connect_address), "connect addr shape: {r:?}");
        }
        eprintln!("LIVE portproxy rules (read-only): {} rule(s)", rules.len());

        // `name=FreshellLANAccess` is a READ-ONLY show; the live host has the rule.
        let ports = get_existing_firewall_ports(&runner).expect("firewall show should resolve");
        eprintln!("LIVE FreshellLANAccess ports (read-only): {ports:?}");
    }
}
