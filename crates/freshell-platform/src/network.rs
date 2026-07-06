//! Network: bind-host resolution, LAN IP detection, access URL, and the
//! **advisory-only** origin / token-gate model.
//!
//! Identical port of `server/get-network-host.ts`, `server/bootstrap.ts`,
//! `server/network-manager.ts`, `server/network-access.ts`, and `server/auth.ts`
//! (`platform-glue.md` §3).
//!
//! ## CD-8 — origin is ADVISORY, the token is the gate
//!
//! There is **no rejecting CORS layer**. The HTTP/WS gate is the auth token
//! (`auth.ts:36-52`, `ws-handler.ts:1096-1121`): a bad `Origin` is *logged, never
//! rejected* (VPNs strip Origin, mobile omits it), and loopback bypasses the
//! check entirely. [`is_origin_allowed`] exists only for advisory logging — do
//! **not** turn it into a rejection without a ledgered `DELIBERATE_FIX`.

use crate::firewall::FirewallPlatform;
use crate::{CommandRunner, Env};

/// The `~/.freshell/config.json` read outcome for [`resolve_bind_host`], modeling
/// the reference's `try { … } catch { … }` (`get-network-host.ts:44-63`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindHostConfig {
    /// Config read/parsed OK: `settings.network.{host,configured}`.
    Ok { raw_host: Option<String>, configured: bool },
    /// Read or JSON parse failed — the `catch` branch.
    Failed,
}

/// `network` intent (`{ configured, host }`) for [`is_remote_access_enabled`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkIntent {
    pub configured: bool,
    pub host: String,
}

fn is_valid_bind(host: &str) -> bool {
    host == "0.0.0.0" || host == "127.0.0.1"
}

/// `getNetworkHost` (`get-network-host.ts:27-64`).
///
/// Order: `FRESHELL_BIND_HOST` (only `0.0.0.0`/`127.0.0.1`) > **Regime-B WSL ->
/// `0.0.0.0`** > config `settings.network.host` (with the unconfigured `HOST`
/// override) > `HOST` env fallback > `127.0.0.1`. `is_wsl` is Regime B
/// (`/proc/version`, the broad `isWSL()`), computed by the caller.
pub fn resolve_bind_host(env: &dyn Env, is_wsl: bool, config: BindHostConfig) -> String {
    if let Some(o) = env.get("FRESHELL_BIND_HOST") {
        if is_valid_bind(&o) {
            return o;
        }
    }

    // On WSL the server must bind 0.0.0.0 so the Windows host browser can reach it.
    if is_wsl {
        return "0.0.0.0".to_string();
    }

    match config {
        BindHostConfig::Ok { raw_host, configured } => {
            let host = match raw_host.as_deref() {
                Some(h) if is_valid_bind(h) => h,
                _ => "127.0.0.1",
            };
            // HOST env only honored when unconfigured.
            if !configured {
                let env_host = env.get("HOST");
                if let Some(h) = env_host.as_deref() {
                    if is_valid_bind(h) {
                        return h.to_string();
                    }
                }
            }
            host.to_string()
        }
        BindHostConfig::Failed => {
            let env_host = env.get("HOST");
            if let Some(h) = env_host.as_deref() {
                if is_valid_bind(h) {
                    return h.to_string();
                }
            }
            "127.0.0.1".to_string()
        }
    }
}

/// `isRemoteAccessEnabled` (`network-access.ts:6-19`).
pub fn is_remote_access_enabled(
    network: Option<&NetworkIntent>,
    effective_host: &str,
    firewall_platform: FirewallPlatform,
) -> bool {
    if network.map(|n| n.host.as_str()) == Some("0.0.0.0") {
        return true;
    }
    if firewall_platform == FirewallPlatform::Wsl2 {
        return false;
    }
    // network?.configured !== true  (absent -> treated as not-configured)
    let configured = network.map(|n| n.configured).unwrap_or(false);
    !configured && effective_host == "0.0.0.0"
}

/// The effective origin host (`network-manager.ts:605-607`): the unconfigured
/// `HOST` override, else the configured network host.
pub fn effective_origin_host(env: &dyn Env, configured: bool, network_host: &str) -> String {
    if !configured {
        if let Some(h) = env.get("HOST").as_deref() {
            if is_valid_bind(h) {
                return h.to_string();
            }
        }
    }
    network_host.to_string()
}

/// `buildAllowedOrigins` (`network-manager.ts:599-626`): loopback origins for
/// `port` (+ `dev_port`), plus `http://<lanIp>:<port>` for each LAN IP when the
/// effective host is `0.0.0.0`. Deduped, order-preserving; `user_origins` first.
pub fn build_allowed_origins(
    user_origins: &[String],
    port: u16,
    dev_port: Option<u16>,
    effective_host: &str,
    lan_ips: &[String],
) -> Vec<String> {
    let mut origins: Vec<String> = Vec::new();
    origins.extend(user_origins.iter().cloned());
    origins.push(format!("http://localhost:{port}"));
    origins.push(format!("http://127.0.0.1:{port}"));
    if let Some(dp) = dev_port {
        origins.push(format!("http://localhost:{dp}"));
        origins.push(format!("http://127.0.0.1:{dp}"));
    }
    if effective_host == "0.0.0.0" && !lan_ips.is_empty() {
        for ip in lan_ips {
            origins.push(format!("http://{ip}:{port}"));
            if let Some(dp) = dev_port {
                origins.push(format!("http://{ip}:{dp}"));
            }
        }
    }
    dedup_preserving_order(origins)
}

fn dedup_preserving_order(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    out
}

/// `parseAllowedOrigins` (`auth.ts:54-67`): `ALLOWED_ORIGINS` split, else the
/// default localhost dev/prod list.
pub fn parse_allowed_origins(env: &dyn Env) -> Vec<String> {
    if let Some(v) = env.get("ALLOWED_ORIGINS") {
        if !v.is_empty() {
            return v
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3002",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// `isOriginAllowed` (`auth.ts:69-73`). **Advisory only** (CD-8) — never use this
/// to *reject* a request; the token is the gate.
pub fn is_origin_allowed(origin: Option<&str>, env: &dyn Env) -> bool {
    match origin {
        None => false,
        Some(o) => parse_allowed_origins(env).iter().any(|a| a == o),
    }
}

/// `isLoopbackAddress` (`auth.ts:75-83`) — loopback clients bypass the origin/token check.
pub fn is_loopback_address(addr: Option<&str>) -> bool {
    match addr {
        None => false,
        Some(a) => {
            a == "127.0.0.1"
                || a == "::1"
                || a.starts_with("::ffff:127.")
                || a == "::ffff:localhost"
        }
    }
}

/// `timingSafeCompare` (`auth.ts:29-34`): length-checked constant-time compare.
/// This is the **actual security gate** for HTTP/WS (`httpAuthMiddleware`).
pub fn timing_safe_compare(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// `encodeURIComponent` — escape everything except the unreserved set
/// `A-Za-z0-9-_.!~*'()`. Used for the token in [`access_url`].
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let c = b as char;
        let unreserved = c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')');
        if unreserved {
            out.push(c);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// `accessUrl` (`network-manager.ts:370-375`): `http://<lanIp|localhost>:<port>/?token=<enc>`.
/// When the share route is enabled, the first LAN IP is used (else `localhost`).
pub fn access_url(
    share_route_enabled: bool,
    lan_ips: &[String],
    access_port: u16,
    token: &str,
) -> String {
    let host = if share_route_enabled {
        lan_ips.first().map(|s| s.as_str()).unwrap_or("localhost")
    } else {
        "localhost"
    };
    format!("http://{host}:{access_port}/?token={}", encode_uri_component(token))
}

// ---------------------------------------------------------------------------
// LAN IP detection (`bootstrap.ts:36-207`)
// ---------------------------------------------------------------------------

/// `scoreLanIp` (`bootstrap.ts:36-60`): higher == more likely the user's LAN IP.
pub fn score_lan_ip(ip: &str, netmask: &str) -> i32 {
    if ip.starts_with("172.17.") {
        return 0; // Docker bridge
    }
    if netmask == "255.255.255.255" {
        return 1; // VPN-style /32
    }
    let octet = |i: usize| ip.split('.').nth(i).and_then(|s| s.parse::<i64>().ok());
    let p0 = octet(0);
    let p1 = octet(1);
    if p0 == Some(192) && p1 == Some(168) {
        return 100;
    }
    if p0 == Some(10) {
        return match p1 {
            Some(v) if v <= 10 => 90,
            _ => 50,
        };
    }
    if p0 == Some(172) {
        if let Some(v) = p1 {
            if (16..=31).contains(&v) {
                return 80;
            }
        }
    }
    10
}

/// `parseWindowsHostIps` (`bootstrap.ts:62-85`): physical-adapter IPv4s from
/// `ipconfig.exe`, skipping virtual adapters.
pub fn parse_windows_host_ips(output: &str) -> Vec<String> {
    let mut ips = Vec::new();
    let mut in_physical = false;
    for line in output.split('\n') {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("adapter") && trimmed.ends_with(':') {
            let is_virtual = ["vethernet", "wsl", "docker", "virtualbox", "vmware"]
                .iter()
                .any(|n| lower.contains(n));
            in_physical = !is_virtual;
        }
        if !in_physical {
            continue;
        }
        if let Some(ip) = parse_ipv4_after_label(trimmed) {
            ips.push(ip);
        }
    }
    ips
}

/// `/IPv4.*?:\s*(\d+\.\d+\.\d+\.\d+)/` (case-sensitive `IPv4`).
fn parse_ipv4_after_label(line: &str) -> Option<String> {
    let idx = line.find("IPv4")?;
    let after = &line[idx..];
    let colon = after.find(':')?;
    let rest = after[colon + 1..].trim_start();
    // Leading `\d+\.\d+\.\d+\.\d+`.
    let bytes = rest.as_bytes();
    let mut i = 0;
    let mut dots = 0;
    let mut digits_in_group = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            digits_in_group += 1;
        } else if bytes[i] == b'.' && digits_in_group > 0 {
            dots += 1;
            digits_in_group = 0;
            if dots > 3 {
                break;
            }
        } else {
            break;
        }
        i += 1;
    }
    let candidate = &rest[..i];
    let parts: Vec<&str> = candidate.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// `rankWindowsHostIps` (`bootstrap.ts:147-149`): score each (netmask assumed
/// `255.255.255.0`), sort by score descending (stable).
pub fn rank_windows_host_ips(ips: &[String]) -> Vec<String> {
    let mut ranked: Vec<String> = ips.to_vec();
    // Descending by score, stable (matches the reference's `sort((a,b)=>score(b)-score(a))`).
    ranked.sort_by_key(|ip| std::cmp::Reverse(score_lan_ip(ip, "255.255.255.0")));
    ranked
}

/// `detectLanIps` WSL branch (`bootstrap.ts:113-125,182-193`): query the Windows
/// host's physical adapters via `ipconfig.exe` and rank them. READ-ONLY. Returns
/// the ranked physical IPs (empty if the query yields none — the reference then
/// falls back to `os.networkInterfaces()`, a live edge left to the server wiring).
pub fn detect_lan_ips_via_ipconfig(runner: &dyn CommandRunner) -> Vec<String> {
    let out = runner.run("/mnt/c/Windows/System32/ipconfig.exe", &[]);
    if !out.ok() {
        return Vec::new();
    }
    rank_windows_host_ips(&parse_windows_host_ips(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, FakeCommandRunner, MapEnv};

    // ---- P10: bind host resolution ----------------------------------------

    #[test]
    fn bind_override_wins() {
        let env = MapEnv::new().with("FRESHELL_BIND_HOST", "0.0.0.0");
        // Even non-WSL with a failed config, the override wins.
        assert_eq!(resolve_bind_host(&env, false, BindHostConfig::Failed), "0.0.0.0");
    }

    #[test]
    fn bind_override_invalid_falls_through() {
        let env = MapEnv::new().with("FRESHELL_BIND_HOST", "1.2.3.4");
        assert_eq!(resolve_bind_host(&env, true, BindHostConfig::Failed), "0.0.0.0"); // WSL
    }

    #[test]
    fn wsl_forces_0000() {
        assert_eq!(resolve_bind_host(&MapEnv::new(), true, BindHostConfig::Failed), "0.0.0.0");
    }

    #[test]
    fn config_host_whitelisted() {
        let cfg = BindHostConfig::Ok { raw_host: Some("0.0.0.0".into()), configured: true };
        assert_eq!(resolve_bind_host(&MapEnv::new(), false, cfg), "0.0.0.0");
        let bad = BindHostConfig::Ok { raw_host: Some("evil".into()), configured: true };
        assert_eq!(resolve_bind_host(&MapEnv::new(), false, bad), "127.0.0.1");
    }

    #[test]
    fn host_env_only_when_unconfigured() {
        let env = MapEnv::new().with("HOST", "0.0.0.0");
        let unconfigured = BindHostConfig::Ok { raw_host: Some("127.0.0.1".into()), configured: false };
        assert_eq!(resolve_bind_host(&env, false, unconfigured), "0.0.0.0");
        let configured = BindHostConfig::Ok { raw_host: Some("127.0.0.1".into()), configured: true };
        assert_eq!(resolve_bind_host(&env, false, configured), "127.0.0.1");
    }

    #[test]
    fn failed_config_falls_back_to_host_then_localhost() {
        assert_eq!(
            resolve_bind_host(&MapEnv::new().with("HOST", "0.0.0.0"), false, BindHostConfig::Failed),
            "0.0.0.0"
        );
        assert_eq!(resolve_bind_host(&MapEnv::new(), false, BindHostConfig::Failed), "127.0.0.1");
    }

    // ---- P16: remote-access truth table -----------------------------------

    #[test]
    fn remote_access_host_0000_is_true() {
        let n = NetworkIntent { configured: false, host: "0.0.0.0".into() };
        assert!(is_remote_access_enabled(Some(&n), "127.0.0.1", FirewallPlatform::Windows));
    }

    #[test]
    fn remote_access_wsl2_is_false_unless_host_0000() {
        let n = NetworkIntent { configured: false, host: "127.0.0.1".into() };
        // wsl2 alone isn't "remote" even though it binds 0.0.0.0.
        assert!(!is_remote_access_enabled(Some(&n), "0.0.0.0", FirewallPlatform::Wsl2));
    }

    #[test]
    fn remote_access_unconfigured_effective_0000() {
        let n = NetworkIntent { configured: false, host: "127.0.0.1".into() };
        assert!(is_remote_access_enabled(Some(&n), "0.0.0.0", FirewallPlatform::Windows));
        let c = NetworkIntent { configured: true, host: "127.0.0.1".into() };
        assert!(!is_remote_access_enabled(Some(&c), "0.0.0.0", FirewallPlatform::Windows));
    }

    // ---- P14: allowed origins ---------------------------------------------

    #[test]
    fn allowed_origins_loopback_only_when_not_0000() {
        let got = build_allowed_origins(&[], 3001, None, "127.0.0.1", &["192.168.1.5".into()]);
        assert_eq!(got, vec!["http://localhost:3001", "http://127.0.0.1:3001"]);
    }

    #[test]
    fn allowed_origins_include_lan_when_0000() {
        let got = build_allowed_origins(
            &["http://custom.example".into()],
            3001,
            Some(5173),
            "0.0.0.0",
            &["192.168.1.5".into()],
        );
        assert_eq!(
            got,
            vec![
                "http://custom.example",
                "http://localhost:3001",
                "http://127.0.0.1:3001",
                "http://localhost:5173",
                "http://127.0.0.1:5173",
                "http://192.168.1.5:3001",
                "http://192.168.1.5:5173",
            ]
        );
    }

    #[test]
    fn allowed_origins_dedup_preserves_order() {
        let got = build_allowed_origins(
            &["http://localhost:3001".into()],
            3001,
            None,
            "127.0.0.1",
            &[],
        );
        assert_eq!(got, vec!["http://localhost:3001", "http://127.0.0.1:3001"]);
    }

    // ---- P13: origin is advisory; the token is the gate -------------------

    #[test]
    fn origin_advisory_token_is_the_real_gate() {
        let env = MapEnv::new(); // default allowlist (no evil origin)
        // A hostile origin is NOT in the allowlist ...
        assert!(!is_origin_allowed(Some("http://evil.example"), &env));
        // ... yet a request bearing the correct token still authorizes (origin is
        // advisory; the WS handler never rejects on it).
        assert!(timing_safe_compare("s3cret-token-1234567", "s3cret-token-1234567"));
        // A wrong token is what actually fails.
        assert!(!timing_safe_compare("s3cret-token-1234567", "nope"));
    }

    #[test]
    fn loopback_addresses() {
        assert!(is_loopback_address(Some("127.0.0.1")));
        assert!(is_loopback_address(Some("::1")));
        assert!(is_loopback_address(Some("::ffff:127.0.0.1")));
        assert!(!is_loopback_address(Some("192.168.1.5")));
        assert!(!is_loopback_address(None));
    }

    #[test]
    fn parse_allowed_origins_default_and_env() {
        assert_eq!(parse_allowed_origins(&MapEnv::new()).len(), 6);
        let env = MapEnv::new().with("ALLOWED_ORIGINS", "http://a:1, http://b:2 ,");
        assert_eq!(parse_allowed_origins(&env), vec!["http://a:1", "http://b:2"]);
    }

    // ---- P15: access URL ---------------------------------------------------

    #[test]
    fn access_url_localhost_when_share_disabled() {
        assert_eq!(
            access_url(false, &["192.168.1.5".into()], 3001, "tok"),
            "http://localhost:3001/?token=tok"
        );
    }

    #[test]
    fn access_url_lan_when_share_enabled_and_encodes_token() {
        assert_eq!(
            access_url(true, &["192.168.1.5".into()], 3001, "a b/c"),
            "http://192.168.1.5:3001/?token=a%20b%2Fc"
        );
    }

    #[test]
    fn access_url_falls_back_to_localhost_without_lan() {
        assert_eq!(access_url(true, &[], 3001, "tok"), "http://localhost:3001/?token=tok");
    }

    // ---- P12: LAN scoring / ipconfig parse --------------------------------

    #[test]
    fn score_lan_ip_ranking() {
        assert_eq!(score_lan_ip("192.168.1.5", "255.255.255.0"), 100);
        assert_eq!(score_lan_ip("10.0.0.4", "255.255.255.0"), 90);
        assert_eq!(score_lan_ip("10.200.0.4", "255.255.255.0"), 50);
        assert_eq!(score_lan_ip("172.20.0.4", "255.255.255.0"), 80);
        assert_eq!(score_lan_ip("172.17.0.1", "255.255.255.0"), 0); // Docker
        assert_eq!(score_lan_ip("100.64.0.1", "255.255.255.255"), 1); // VPN /32
        assert_eq!(score_lan_ip("100.64.0.1", "255.255.255.0"), 10); // other
    }

    #[test]
    fn parse_windows_host_ips_skips_virtual_adapters() {
        let out = "\
Windows IP Configuration\r\n\r\n\
Ethernet adapter Ethernet:\r\n\
   IPv4 Address. . . . . . . . . . . : 192.168.1.50\r\n\r\n\
Ethernet adapter vEthernet (WSL):\r\n\
   IPv4 Address. . . . . . . . . . . : 172.30.144.1\r\n";
        assert_eq!(parse_windows_host_ips(out), vec!["192.168.1.50"]);
    }

    #[test]
    fn rank_windows_host_ips_orders_by_score() {
        let ips = vec!["10.200.0.4".into(), "192.168.1.5".into(), "172.20.0.1".into()];
        assert_eq!(
            rank_windows_host_ips(&ips),
            vec!["192.168.1.5", "172.20.0.1", "10.200.0.4"]
        );
    }

    #[test]
    fn detect_lan_ips_via_ipconfig_fake() {
        let runner = FakeCommandRunner::new().on(
            "/mnt/c/Windows/System32/ipconfig.exe",
            &[],
            CommandOutput::success(
                "Ethernet adapter Ethernet:\r\n   IPv4 Address. . . : 192.168.1.50\r\n",
            ),
        );
        assert_eq!(detect_lan_ips_via_ipconfig(&runner), vec!["192.168.1.50"]);
    }

    // ---- READ-ONLY live verification (skips off-WSL) ----------------------

    /// P12 (`LV? = yes`): the real `ipconfig.exe` physical-adapter read via
    /// [`crate::StdCommandRunner`]. READ-ONLY; asserts IPv4 parse-shape only.
    #[test]
    fn live_ipconfig_lan_ips_readonly() {
        let ipconfig = "/mnt/c/Windows/System32/ipconfig.exe";
        if !std::path::Path::new(ipconfig).exists() {
            eprintln!("SKIP live_ipconfig_lan_ips_readonly: {ipconfig} absent");
            return;
        }
        let runner = crate::StdCommandRunner::default();
        let ips = detect_lan_ips_via_ipconfig(&runner);
        for ip in &ips {
            let parts: Vec<&str> = ip.split('.').collect();
            assert_eq!(parts.len(), 4, "IPv4 shape: {ip}");
        }
        eprintln!("LIVE ipconfig LAN IPs (read-only): {ips:?}");
    }
}
