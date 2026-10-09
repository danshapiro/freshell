//! Per-pane OS containment for Freshell coding-agent panes.
//!
//! A pane is ONE unit: its screen (PTY child), its agent main process, and
//! everything they start. This crate owns how the unit's processes are
//! grouped (per OS backend), how their exit is observed without polling
//! (`ProcWatch`), and the single stop sequence. Lifecycle STATE (Running /
//! Stopping / Gone) lives in `freshell-ownership`, never here.

use std::future::Future;
use std::pin::Pin;

pub mod events;
pub mod exec_shim;
pub mod listener;
pub mod locks;
#[cfg(test)]
mod log_capture;
pub mod proc_watch;
pub mod process;
pub mod startup;
pub mod testing;
pub mod unit_id;

pub use listener::listening_socket_owner;
pub use locks::{codex_thread_lock_path, lock_holders, lock_holders_among, LockHolder};
pub use proc_watch::{ProcWatch, Sig};
pub use process::{identity, is_codex_daemon_family, ProcIdentity};
pub use unit_id::{UnitId, LEGACY_CODEX_TAG_ENV, UNIT_ENV};

/// A boxed, sendable future (no `futures` dependency).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
