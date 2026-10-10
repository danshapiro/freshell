//! Per-pane OS containment for Freshell coding-agent panes.
//!
//! A pane is ONE unit: its screen (PTY child), its agent main process, and
//! everything they start. This crate owns how the unit's processes are
//! grouped (per OS backend), how their exit is observed without polling
//! (`ProcWatch`), and the single stop sequence. Lifecycle STATE (Running /
//! Stopping / Gone) lives in `freshell-ownership`, never here.

use std::future::Future;
use std::pin::Pin;

mod backend;
pub mod containment;
#[cfg(target_os = "macos")]
mod darwin;
pub mod directory;
pub mod events;
pub mod exec_shim;
pub mod listener;
pub mod locks;
#[cfg(test)]
mod log_capture;
pub mod proc_watch;
pub mod process;
#[cfg(target_os = "linux")]
mod reaper;
pub mod record;
pub mod startup;
pub mod testing;
pub mod unit;
pub mod unit_id;

pub use backend::{BackendKind, Capability};
pub use containment::{
    global_containment, global_or_fallback_containment, set_global_containment, Containment,
    SelectOptions, ShimCommand,
};
pub use directory::{AbandonedStart, UnitDirectory, UnitEntry, UnitLifecycle};
pub use listener::listening_socket_owner;
pub use locks::{codex_thread_lock_path, lock_holders, lock_holders_among, LockHolder};
pub use proc_watch::{ProcWatch, Sig};
pub use process::{identity, is_codex_daemon_family, ProcIdentity};
pub use record::{UnitRecord, UnitRecordState};
pub use unit::{
    AgentUnit, GoneCallback, MemberRole, Placement, StopHandle, StopMode, StopReason, StopReport,
    StopRequest, UnitLabel, FORCE_GRACE, PLACEMENT_DEADLINE, POST_GONE_EMPTY_WAIT,
    UNCONFIRMED_AFTER,
};
pub use unit_id::{UnitId, LEGACY_CODEX_TAG_ENV, UNIT_ENV};

/// A boxed, sendable future (no `futures` dependency).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
