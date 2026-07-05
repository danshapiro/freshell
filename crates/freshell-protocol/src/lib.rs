//! # freshell-protocol
//!
//! Rust wire types for the **frozen** freshell WebSocket protocol, modeled
//! faithfully from the language-neutral contract in `port/contract/`:
//!
//! * `ws-protocol.schema.json` — inbound (client→server) Zod authority.
//! * `ws-server-messages.schema.json` — outbound (server→client) shape authority.
//! * `ws-message-inventory.json` — the T0 conformance surface (`type` set).
//!
//! This crate is **serialization only, no logic** (ADR Decision 1/5). It is the
//! shared seam consumed by the future Rust server and the equivalence oracle.
//! Changing the wire is out of scope; the contract is pinned at
//! `WS_PROTOCOL_VERSION = 7`.
//!
//! ## Modeling notes
//!
//! * Discriminated unions use serde's internally-tagged `#[serde(tag = "type")]`
//!   with each variant renamed to its exact wire `type` string.
//! * Inbound deserialization is **accept-and-strip** — no `deny_unknown_fields`
//!   anywhere — mirroring the runtime's zod `.strip()` behavior.
//! * Opaque blobs (`unknown`, `Record<string, unknown>`, SDK `event` payloads)
//!   are [`serde_json::Value`].
//! * Optional fields skip serialization when absent, so wire bytes are preserved.

pub mod client_messages;
pub mod common;
pub mod server_messages;
pub mod settings;

pub use client_messages::*;
pub use common::*;
pub use server_messages::*;
pub use settings::*;

/// The frozen WebSocket protocol version. Asserted equal to the committed
/// contract (`shared/ws-version.ts`, `ws-message-inventory.json`) by the tests.
pub const WS_PROTOCOL_VERSION: u32 = 7;

/// Every `type` discriminant the protocol speaks, both directions, sorted.
/// (27 client→server + 52 server→client = 79.)
pub fn all_message_types() -> Vec<&'static str> {
    let mut types: Vec<&'static str> = client_messages::CLIENT_MESSAGE_TYPES
        .iter()
        .chain(server_messages::SERVER_MESSAGE_TYPES.iter())
        .copied()
        .collect();
    types.sort_unstable();
    types
}
