//! Extension manifest validation for the freshell Rust port (df1 EXT-01).
//!
//! Ports the strict manifest schema with behavior-for-behavior parity:
//!
//! * strict objects reject unknown keys at every level (`unrecognized_keys`)
//! * category↔config-block coupling refine (exactly one `client`/`server`/
//!   `cli` block, matching `category`), including zod-4's refine-gating abort
//!   rule (aborting issue codes suppress refines; check codes don't) and its
//!   best-effort block presence semantics
//! * defaults materialize in validated output: `server.args=[]`,
//!   `server.readyTimeout=10000`, `server.singleton=true`, `cli.args=[]`
//! * `readyTimeout` is a JS-safe-int (`±2^53-1`) positive millisecond value
//! * bare-string fields (`icon`, `url`, `envVar`, `readyPattern`, …) ACCEPT
//!   empty strings; only `name`/`version`/`label`/`description`/
//!   `client.entry`/`server.command`/`cli.command` enforce min(1)
//! * `.optional()` means ABSENT-or-`T` — a literal JSON `null` is rejected
//! * content-schema field `default` is `string | number | boolean` and, when
//!   present, must match the declared field `type` (JS `typeof` semantics)
//! * issues carry zod-4's exact (code, path, message) triples, in zod's
//!   emission order (schema-definition order; `unrecognized_keys` last per
//!   object; refines after their object's base issues)
//!
//! Behavior is pinned by the frozen migration fixture
//! `fixtures/manifest-oracle.json` (124 cases), iterated by `tests/oracle.rs`.
//! Keep the fixture as provenance and fix this crate when it exposes a mismatch.
//!
//! Locale note: JSON text in, typed manifest out. No I/O, no clocks, no
//! randomness — hermetic by construction.

mod issue;
mod manifest;
mod validate;

pub use issue::{IssueCode, ManifestError, ManifestIssue, PathSeg};
pub use manifest::{
    Category, CliConfig, ClientConfig, ContentSchemaField, DefaultValue, ExtensionManifest,
    FieldType, PickerConfig, PreferredRenderer, ScrollInputPolicy, ServerConfig, TerminalBehavior,
};
pub use validate::{parse_manifest, validate_manifest};
