//! WSL port-forward: `netsh portproxy` + firewall script builders/plans
//! (`server/wsl-port-forward.ts`, `platform-glue.md §4`).
//!
//! **DEFERRED — not implemented in this sub-step.** This is a live-process +
//! elevated-mutation piece and is explicitly out of scope for the deterministic
//! core. Scaffolded here as clearly-marked `todo!()` stubs with **no behavior**.
//!
//! Fidelity reminders for the live sub-step (do NOT lose these):
//! - Script builders are **byte-load-bearing** (they feed an elevated shell):
//!   `2>\$null` -> `$null` normalize, semicolon join, **delete-then-add** ordering,
//!   spaceless rule name `FreshellLANAccess` (`wsl-port-forward.ts:289-398`).
//!   The live sub-step MUST golden-string these, never re-run elevation.
//! - `[SAFETY]` portproxy/firewall add/delete are elevated & mutating — the live
//!   `DANDESKTOP` host already has real rules; only `show` is safe here.
//! - Kill-switch `FRESHELL_DISABLE_WSL_PORT_FORWARD` in {`1`,`true`,`yes`}.

#![allow(unused_variables)]

/// `buildPortForwardingScript` (`wsl-port-forward.ts:324-351`). **DEFERRED stub — no behavior.**
pub fn build_port_forwarding_script(ports: &[u16], wsl_ip: &str, cleanup_ports: &[u16]) -> String {
    todo!("freshell-platform: WSL port-forward script builders are deferred to a later sub-step")
}

/// `buildWslPortForwardingPlan` (`wsl-port-forward.ts:428-475`). **DEFERRED stub — no behavior.**
pub async fn build_wsl_port_forwarding_plan() {
    todo!("freshell-platform: WSL port-forward planning is deferred to a later sub-step")
}
