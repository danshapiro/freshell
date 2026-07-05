//! Firewall detection & command builders (`server/firewall.ts`, `platform-glue.md §5`).
//!
//! **DEFERRED — not implemented in this sub-step.** This is a live-process piece
//! (`ufw`/`firewall-cmd`/`netsh.exe`/`defaults` subprocesses) that belongs to a
//! later platform sub-step; only the deterministic core (detection/path/spawn) is
//! built now. The surface is scaffolded here so downstream crates can see the
//! intended shape, but every function is a clearly-marked `todo!()` stub with **no
//! behavior**. Do not call these yet.
//!
//! Planned surface (see spec §5):
//! - `detectFirewall` (`firewall.ts:107-127`) — per-platform active probe.
//! - `firewallCommands` (`firewall.ts:129-163`) — suggested command strings.

#![allow(unused_variables)]

/// `FirewallPlatform` (`firewall.ts`). Deferred — enum shape TBD in the live sub-step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirewallPlatform {
    LinuxUfw,
    LinuxFirewalld,
    LinuxNone,
    Macos,
    Windows,
    Wsl2,
}

/// `detectFirewall` (`firewall.ts:107-127`). **DEFERRED stub — no behavior.**
pub async fn detect_firewall() -> FirewallStatus {
    todo!("freshell-platform: firewall detection is deferred to a later sub-step")
}

/// `firewallCommands` (`firewall.ts:129-163`). **DEFERRED stub — no behavior.**
pub fn firewall_commands(platform: FirewallPlatform, ports: &[u16]) -> Vec<String> {
    todo!("freshell-platform: firewall command builders are deferred to a later sub-step")
}

/// Placeholder result type. Deferred — real shape TBD in the live sub-step.
#[derive(Debug, Clone)]
pub struct FirewallStatus {
    pub platform: FirewallPlatform,
    pub active: bool,
}
