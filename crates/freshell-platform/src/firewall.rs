//! Firewall detection & command builders.
//!
//! Identical port of `server/firewall.ts` (detection + suggested commands,
//! `platform-glue.md` §5) plus the **native-Windows managed-rule** builders from
//! `server/network-manager.ts:56-187` (`Freshell (port <p>)` add/delete/repair
//! and the `show → exists? → add` idempotency probe).
//!
//! Subprocess execution is injected via [`CommandRunner`]. Detection and the
//! `show`-rule existence probe are READ-ONLY; the `add`/`delete` commands are
//! only ever *built as strings* (they are executed later behind the elevated
//! layer, [`crate::elevated`]). Golden-string tests pin every command shape.
//!
//! **Escaping note (byte-load-bearing):** the native-Windows managed rules use a
//! plain `2>$null` (`network-manager.ts:161`, straight to elevated PowerShell),
//! **not** the `2>\$null` sh-then-normalize form the WSL scripts use
//! (`wsl-port-forward.ts`, see [`crate::port_forward`]). `protocol=TCP` is
//! upper-case for the suggested/managed Windows rules (`firewall.ts:153`,
//! `network-manager.ts:167`); the WSL `FreshellLANAccess` rule uses lower-case
//! `protocol=tcp`.

use crate::{CommandRunner, HostOs};

/// `FirewallPlatform` (`firewall.ts:7-13`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirewallPlatform {
    LinuxUfw,
    LinuxFirewalld,
    LinuxNone,
    Macos,
    Windows,
    Wsl2,
}

impl FirewallPlatform {
    /// The exact string the reference uses on the wire (`firewall.ts:7-13`).
    pub fn as_str(self) -> &'static str {
        match self {
            FirewallPlatform::LinuxUfw => "linux-ufw",
            FirewallPlatform::LinuxFirewalld => "linux-firewalld",
            FirewallPlatform::LinuxNone => "linux-none",
            FirewallPlatform::Macos => "macos",
            FirewallPlatform::Windows => "windows",
            FirewallPlatform::Wsl2 => "wsl2",
        }
    }
}

/// `FirewallInfo` (`firewall.ts:15-18`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirewallInfo {
    pub platform: FirewallPlatform,
    pub active: bool,
}

/// `netshCmd` selection (`firewall.ts:88-90`): the full `netsh.exe` path on WSL2
/// (bare `netsh` is not reliably on PATH there), bare `netsh` on native Windows.
pub fn netsh_cmd(is_wsl2: bool) -> &'static str {
    if is_wsl2 {
        "/mnt/c/Windows/System32/netsh.exe"
    } else {
        "netsh"
    }
}

/// `\bON\b/i` (`firewall.ts:101`): whole-word case-insensitive `ON`. `\b` sits
/// between a word char (`[A-Za-z0-9_]`) and a non-word char.
fn has_on_word(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    let b = lower.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0;
    while i + 2 <= b.len() {
        if &b[i..i + 2] == b"on" {
            let before_ok = i == 0 || !is_word(b[i - 1]);
            let after_ok = i + 2 == b.len() || !is_word(b[i + 2]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// `tryExec` (`firewall.ts:27-34`): stdout on success, else `None`.
fn try_exec(runner: &dyn CommandRunner, cmd: &str, args: &[&str]) -> Option<String> {
    runner.run(cmd, args).stdout_on_success().map(|s| s.to_string())
}

fn detect_linux_firewall(runner: &dyn CommandRunner) -> FirewallInfo {
    // ufw first (Ubuntu/Debian/Mint/Pop!_OS).
    let ufw = try_exec(runner, "ufw", &["status"]);
    if let Some(ref out) = ufw {
        if out.contains("Status: active") {
            return FirewallInfo { platform: FirewallPlatform::LinuxUfw, active: true };
        }
    }

    // firewalld (Fedora/RHEL/CentOS).
    if let Some(out) = try_exec(runner, "firewall-cmd", &["--state"]) {
        if out.trim() == "running" {
            return FirewallInfo { platform: FirewallPlatform::LinuxFirewalld, active: true };
        }
    }

    // ufw present-but-inactive still reported (user may want to enable it).
    if ufw.is_some() {
        return FirewallInfo { platform: FirewallPlatform::LinuxUfw, active: false };
    }

    FirewallInfo { platform: FirewallPlatform::LinuxNone, active: false }
}

fn detect_mac_firewall(runner: &dyn CommandRunner) -> FirewallInfo {
    let out = try_exec(
        runner,
        "defaults",
        &["read", "/Library/Preferences/com.apple.alf", "globalstate"],
    );
    match out {
        // `parseInt(output.trim(), 10) > 0` (leading-int parse, like JS parseInt).
        Some(o) => FirewallInfo {
            platform: FirewallPlatform::Macos,
            active: crate::port_forward::parse_int_prefix(o.trim()).is_some_and(|n| n > 0),
        },
        None => FirewallInfo { platform: FirewallPlatform::Macos, active: false },
    }
}

fn detect_windows_firewall(is_wsl2: bool, runner: &dyn CommandRunner) -> FirewallInfo {
    let cmd = netsh_cmd(is_wsl2);
    let out = try_exec(runner, cmd, &["advfirewall", "show", "currentprofile", "state"]);
    let platform = if is_wsl2 { FirewallPlatform::Wsl2 } else { FirewallPlatform::Windows };
    match out {
        Some(o) => FirewallInfo { platform, active: has_on_word(&o) },
        None => FirewallInfo { platform, active: false },
    }
}

/// `detectFirewall` (`firewall.ts:107-127`).
///
/// `host_os` is `process.platform`; `is_wsl2` is Regime B (`/proc/version`).
pub fn detect_firewall(host_os: HostOs, is_wsl2: bool, runner: &dyn CommandRunner) -> FirewallInfo {
    match host_os {
        HostOs::Linux => {
            if is_wsl2 {
                detect_windows_firewall(is_wsl2, runner)
            } else {
                detect_linux_firewall(runner)
            }
        }
        HostOs::Macos => detect_mac_firewall(runner),
        HostOs::Windows => detect_windows_firewall(is_wsl2, runner),
    }
}

/// `firewallCommands` (`firewall.ts:129-163`) — suggested commands as data.
pub fn firewall_commands(platform: FirewallPlatform, ports: &[u16]) -> Vec<String> {
    match platform {
        FirewallPlatform::LinuxUfw => {
            ports.iter().map(|p| format!("sudo ufw allow {p}/tcp")).collect()
        }
        FirewallPlatform::LinuxFirewalld => {
            let port_args = ports
                .iter()
                .map(|p| format!("--add-port={p}/tcp"))
                .collect::<Vec<_>>()
                .join(" ");
            vec![format!(
                "sudo firewall-cmd {port_args} --permanent && sudo firewall-cmd --reload"
            )]
        }
        FirewallPlatform::Macos => vec![
            "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node) && \
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)"
                .to_string(),
        ],
        FirewallPlatform::Windows => ports
            .iter()
            .map(|p| {
                format!(
                    "netsh advfirewall firewall add rule name=\"Freshell (port {p})\" \
dir=in action=allow protocol=TCP localport={p} profile=private"
                )
            })
            .collect(),
        // WSL2 repair is handled by port_forward; linux-none has nothing to do.
        FirewallPlatform::Wsl2 | FirewallPlatform::LinuxNone => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Native-Windows managed rules (`network-manager.ts:56-187`)
// ---------------------------------------------------------------------------

/// `getManagedWindowsFirewallRuleName` (`network-manager.ts:56-58`).
pub fn managed_windows_firewall_rule_name(port: u16) -> String {
    format!("Freshell (port {port})")
}

/// `normalizeWindowsFirewallPorts` (`network-manager.ts:60-64`): dedupe, keep
/// `1..=65535`, sort ascending. (All `u16` are `<= 65535`, so only `>= 1`.)
pub fn normalize_windows_firewall_ports(ports: &[u16]) -> Vec<u16> {
    let mut set: std::collections::BTreeSet<u16> = std::collections::BTreeSet::new();
    for &p in ports {
        if p >= 1 {
            set.insert(p);
        }
    }
    set.into_iter().collect()
}

/// `buildWindowsFirewallDeleteCommands` (`network-manager.ts:159-163`).
/// Note the plain `2>$null` (no backslash) — straight to elevated PowerShell.
pub fn build_windows_firewall_delete_commands(ports: &[u16]) -> Vec<String> {
    normalize_windows_firewall_ports(ports)
        .into_iter()
        .map(|p| {
            format!(
                "netsh advfirewall firewall delete rule name=\"{}\" 2>$null",
                managed_windows_firewall_rule_name(p)
            )
        })
        .collect()
}

/// `buildWindowsFirewallAddCommands` (`network-manager.ts:165-169`).
pub fn build_windows_firewall_add_commands(ports: &[u16]) -> Vec<String> {
    normalize_windows_firewall_ports(ports)
        .into_iter()
        .map(|p| {
            format!(
                "netsh advfirewall firewall add rule name=\"{}\" \
dir=in action=allow protocol=TCP localport={p} profile=private",
                managed_windows_firewall_rule_name(p)
            )
        })
        .collect()
}

/// `buildWindowsFirewallRepairCommands` (`network-manager.ts:171-187`) — the
/// `show → exists? → add` idempotency: delete stale managed ports, then add the
/// required ports (only the *missing* ones when the advertised port is already
/// reachable, otherwise all of them).
pub fn build_windows_firewall_repair_commands(
    required_ports: &[u16],
    existing_managed_ports: &[u16],
    advertised_port_reachable: bool,
) -> Vec<String> {
    let required_set: std::collections::BTreeSet<u16> = required_ports.iter().copied().collect();
    let existing_set: std::collections::BTreeSet<u16> =
        existing_managed_ports.iter().copied().collect();

    let stale_ports: Vec<u16> = normalize_windows_firewall_ports(existing_managed_ports)
        .into_iter()
        .filter(|p| !required_set.contains(p))
        .collect();

    let add_ports: Vec<u16> = if advertised_port_reachable {
        required_ports
            .iter()
            .copied()
            .filter(|p| !existing_set.contains(p))
            .collect()
    } else {
        required_ports.to_vec()
    };

    let mut out = build_windows_firewall_delete_commands(&stale_ports);
    out.extend(build_windows_firewall_add_commands(&add_ports));
    out
}

/// `getExistingManagedWindowsFirewallPorts` (`network-manager.ts:139-157`) — the
/// READ-ONLY `show rule` existence probe. A port counts as present when the
/// probe exits 0 **or** the combined `stdout\nstderr` contains the rule name.
///
/// Native-Windows uses the bare `netsh` command (`network-manager.ts:145`); this
/// path never runs on WSL, so it is exercised only via a [`crate::FakeCommandRunner`].
pub fn get_existing_managed_windows_firewall_ports(
    runner: &dyn CommandRunner,
    ports: &[u16],
) -> Vec<u16> {
    let mut existing: std::collections::BTreeSet<u16> = std::collections::BTreeSet::new();
    for p in normalize_windows_firewall_ports(ports) {
        let rule_name = managed_windows_firewall_rule_name(p);
        let name_arg = format!("name={rule_name}");
        let out = runner.run(
            "netsh",
            &["advfirewall", "firewall", "show", "rule", name_arg.as_str()],
        );
        let combined = format!("{}\n{}", out.stdout, out.stderr);
        if out.ok() || combined.contains(&rule_name) {
            existing.insert(p);
        }
    }
    existing.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, FakeCommandRunner};

    // ---- firewallCommands golden strings (P24) ----------------------------

    #[test]
    fn ufw_commands_per_port() {
        assert_eq!(
            firewall_commands(FirewallPlatform::LinuxUfw, &[3001, 3002]),
            vec!["sudo ufw allow 3001/tcp", "sudo ufw allow 3002/tcp"]
        );
    }

    #[test]
    fn firewalld_single_joined_command() {
        assert_eq!(
            firewall_commands(FirewallPlatform::LinuxFirewalld, &[3001, 3002]),
            vec![
                "sudo firewall-cmd --add-port=3001/tcp --add-port=3002/tcp --permanent \
&& sudo firewall-cmd --reload"
            ]
        );
    }

    #[test]
    fn macos_app_level_command() {
        assert_eq!(
            firewall_commands(FirewallPlatform::Macos, &[3001]),
            vec![
                "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node) && \
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)"
            ]
        );
    }

    #[test]
    fn windows_suggested_command_golden() {
        // Quoted spaced name + upper-case protocol=TCP (firewall.ts:153).
        assert_eq!(
            firewall_commands(FirewallPlatform::Windows, &[3001]),
            vec![
                "netsh advfirewall firewall add rule name=\"Freshell (port 3001)\" \
dir=in action=allow protocol=TCP localport=3001 profile=private"
            ]
        );
    }

    #[test]
    fn wsl2_and_none_are_empty() {
        assert!(firewall_commands(FirewallPlatform::Wsl2, &[3001]).is_empty());
        assert!(firewall_commands(FirewallPlatform::LinuxNone, &[3001]).is_empty());
    }

    // ---- Windows managed rule golden strings (network-manager.ts) ----------

    #[test]
    fn managed_delete_uses_plain_dollar_null() {
        // Plain `2>$null` — NOT the WSL `2>\$null` form.
        assert_eq!(
            build_windows_firewall_delete_commands(&[3001]),
            vec!["netsh advfirewall firewall delete rule name=\"Freshell (port 3001)\" 2>$null"]
        );
    }

    #[test]
    fn managed_add_golden() {
        assert_eq!(
            build_windows_firewall_add_commands(&[3001]),
            vec![
                "netsh advfirewall firewall add rule name=\"Freshell (port 3001)\" \
dir=in action=allow protocol=TCP localport=3001 profile=private"
            ]
        );
    }

    #[test]
    fn normalize_dedupes_and_sorts() {
        assert_eq!(normalize_windows_firewall_ports(&[3002, 3001, 3001, 0]), vec![3001, 3002]);
    }

    #[test]
    fn repair_reachable_adds_only_missing_and_deletes_stale() {
        // required {3001}, existing managed {3002 stale, 3001 present}, reachable.
        let cmds = build_windows_firewall_repair_commands(&[3001], &[3001, 3002], true);
        assert_eq!(
            cmds,
            vec![
                "netsh advfirewall firewall delete rule name=\"Freshell (port 3002)\" 2>$null"
                    .to_string(),
            ]
        );
    }

    #[test]
    fn repair_unreachable_adds_all_required() {
        // Not reachable -> add ALL required even if present; still delete stale.
        let cmds = build_windows_firewall_repair_commands(&[3001], &[3001, 3002], false);
        assert_eq!(
            cmds,
            vec![
                "netsh advfirewall firewall delete rule name=\"Freshell (port 3002)\" 2>$null"
                    .to_string(),
                "netsh advfirewall firewall add rule name=\"Freshell (port 3001)\" \
dir=in action=allow protocol=TCP localport=3001 profile=private"
                    .to_string(),
            ]
        );
    }

    // ---- detection via fakes ----------------------------------------------

    #[test]
    fn detect_wsl2_active_on() {
        let runner = FakeCommandRunner::new().on(
            "/mnt/c/Windows/System32/netsh.exe",
            &["currentprofile", "state"],
            CommandOutput::success("Private Profile Settings:\r\nState  ON\r\nOk.\r\n"),
        );
        let info = detect_firewall(HostOs::Linux, true, &runner);
        assert_eq!(info, FirewallInfo { platform: FirewallPlatform::Wsl2, active: true });
    }

    #[test]
    fn detect_windows_state_off_is_inactive() {
        let runner = FakeCommandRunner::new().on(
            "netsh",
            &["currentprofile", "state"],
            CommandOutput::success("State  OFF\r\nOk.\r\n"),
        );
        let info = detect_firewall(HostOs::Windows, false, &runner);
        assert_eq!(info, FirewallInfo { platform: FirewallPlatform::Windows, active: false });
    }

    #[test]
    fn has_on_word_is_boundary_sensitive() {
        assert!(has_on_word("State ON"));
        assert!(has_on_word("state on\r"));
        assert!(!has_on_word("iron")); // 'on' inside a word must not match
        assert!(!has_on_word("onstate")); // trailing word char
        assert!(!has_on_word("State OFF"));
    }

    #[test]
    fn detect_linux_ufw_active() {
        let runner = FakeCommandRunner::new()
            .on("ufw", &["status"], CommandOutput::success("Status: active\n"));
        assert_eq!(
            detect_firewall(HostOs::Linux, false, &runner),
            FirewallInfo { platform: FirewallPlatform::LinuxUfw, active: true }
        );
    }

    #[test]
    fn detect_linux_ufw_inactive_falls_through_to_firewalld() {
        let runner = FakeCommandRunner::new()
            .on("ufw", &["status"], CommandOutput::success("Status: inactive\n"))
            .on("firewall-cmd", &["--state"], CommandOutput::success("running\n"));
        assert_eq!(
            detect_firewall(HostOs::Linux, false, &runner),
            FirewallInfo { platform: FirewallPlatform::LinuxFirewalld, active: true }
        );
    }

    #[test]
    fn detect_linux_none_when_no_tools() {
        // Both probes fail to spawn -> linux-none.
        let runner = FakeCommandRunner::new();
        assert_eq!(
            detect_firewall(HostOs::Linux, false, &runner),
            FirewallInfo { platform: FirewallPlatform::LinuxNone, active: false }
        );
    }

    #[test]
    fn managed_windows_exists_probe_by_exit0_or_name_in_output() {
        // 3001: exit 0 -> present. 3002: exit 1 but stdout has the name -> present.
        // 3003: exit 1 and no name -> absent.
        let runner = FakeCommandRunner::new()
            .on("netsh", &["name=Freshell (port 3001)"], CommandOutput::success("Rule Name: ...\n"))
            .on(
                "netsh",
                &["name=Freshell (port 3002)"],
                CommandOutput::failure(1, "Rule Name: Freshell (port 3002)\n", ""),
            )
            .on(
                "netsh",
                &["name=Freshell (port 3003)"],
                CommandOutput::failure(1, "No rules match the specified criteria.\n", ""),
            );
        assert_eq!(
            get_existing_managed_windows_firewall_ports(&runner, &[3001, 3002, 3003]),
            vec![3001, 3002]
        );
    }

    // ---- READ-ONLY live verification (skips if netsh.exe absent) -----------

    /// P23 (`LV? = yes` on this WSL2 host): drive the *real* `detect_firewall`
    /// through [`crate::StdCommandRunner`] against `netsh.exe advfirewall show
    /// currentprofile state`. READ-ONLY (`show`); asserts parse-shape only. Skips
    /// where the interop binary is absent (non-WSL CI).
    #[test]
    fn live_detect_firewall_wsl2_readonly() {
        let netsh = "/mnt/c/Windows/System32/netsh.exe";
        if !std::path::Path::new(netsh).exists() {
            eprintln!("SKIP live_detect_firewall_wsl2_readonly: {netsh} absent");
            return;
        }
        let runner = crate::StdCommandRunner::default();
        let info = detect_firewall(HostOs::Linux, true, &runner);
        // Shape only: on WSL2 the platform is always `wsl2`; `active` is a bool.
        assert_eq!(info.platform, FirewallPlatform::Wsl2);
        eprintln!("LIVE detect_firewall (read-only) -> {info:?}");
    }
}
