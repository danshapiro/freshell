//! Network: bind-host resolution, LAN IP detection, advisory origins
//! (`server/get-network-host.ts`, `bootstrap.ts`, `network-manager.ts`;
//! `platform-glue.md §3`).
//!
//! **DEFERRED — not implemented in this sub-step.** Bind-host + port selection are
//! pure and will land in the live sub-step alongside the LAN/`ipconfig.exe` reads
//! and the advisory-origin builder. Scaffolded here as clearly-marked `todo!()`
//! stubs with **no behavior**.
//!
//! Fidelity reminders for the live sub-step (do NOT lose these):
//! - Bind host order: `FRESHELL_BIND_HOST` (only `0.0.0.0`/`127.0.0.1`) > **Regime B
//!   WSL -> `0.0.0.0`** > config `settings.network.host` > `HOST` env > `127.0.0.1`
//!   (`get-network-host.ts:27-64`).
//! - Port: `PORT` env (1..=65535) else **3001** (`wsl-port-forward.ts:174-179`).
//! - **Origin handling is ADVISORY-ONLY** — logged, never rejected; the auth token
//!   is the gate (`platform-glue.md §3.4`, CD-8). Do NOT harden into a rejecting
//!   CORS layer without a ledgered `DELIBERATE_FIX`.

#![allow(unused_variables)]

/// `getNetworkHost` bind-host resolution (`get-network-host.ts:27-64`).
/// **DEFERRED stub — no behavior.**
pub fn resolve_bind_host() -> String {
    todo!("freshell-platform: bind-host resolution is deferred to a later sub-step")
}

/// LAN IP detection (`bootstrap.ts:182-207`). **DEFERRED stub — no behavior.**
pub async fn detect_lan_ips() -> Vec<String> {
    todo!("freshell-platform: LAN IP detection is deferred to a later sub-step")
}
