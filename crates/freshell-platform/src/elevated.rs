//! Elevated PowerShell (`server/elevated-powershell.ts`, `platform-glue.md §6`).
//!
//! **DEFERRED — not implemented in this sub-step.** UAC `Start-Process -Verb RunAs`
//! is a live, interactive, native-Windows-only, non-CI-automatable path. Scaffolded
//! here as clearly-marked `todo!()` stubs with **no behavior**.
//!
//! Fidelity reminder for the live sub-step (do NOT lose this):
//! - `buildElevatedPowerShellArgs` (`elevated-powershell.ts:11-30`): `script.replace(/'/g,"''")`,
//!   then `['-Command', "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '<escaped>'"]`.
//!   This is a **byte-exact golden** (P25) — build & diff the arg strings; never run UAC in CI.

#![allow(unused_variables)]

/// `buildElevatedPowerShellArgs` (`elevated-powershell.ts:11-30`). **DEFERRED stub — no behavior.**
pub fn build_elevated_powershell_args(script: &str) -> Vec<String> {
    todo!("freshell-platform: elevated-PowerShell arg building is deferred to a later sub-step")
}
