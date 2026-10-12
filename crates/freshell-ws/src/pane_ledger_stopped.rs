//! The stopped-pane memory (Task 18; Stage 2: LB-36, LB-13, LB-42): one
//! durable record per stop of a pane that a person asked for (a kill, a
//! cleanup stop) or that ended cleanly by itself (an agent quit with exit
//! code 0), so a device that comes back late or after being offline is told
//! "stopped" instead of re-creating the pane's conversation.
//!
//! A record matches only the stopped pane's own copies: its terminal id or
//! its createRequestId (a fresh-agent pane, which has no terminal, by the
//! createRequestId of the pane a person closed; never by its conversation).
//! A reopen mints a new createRequestId, so a reopened pane never matches;
//! nothing a create or a claim does clears a record. Records are kept with
//! no expiry (the GC never touches them): a device that returns after any
//! length of time is still answered "stopped".
//!
//! Layout: `stopped-panes/<enc(key)>.json`, one file per record, named by
//! [`StoppedPaneRecord::key`]. Distinct stops have distinct keys (every spawn
//! has a new terminal id and every reopen mints a new createRequestId), so no
//! write replaces the record of an earlier stop. Child module of
//! `pane_ledger` (the `pane_ledger_scan.rs` convention), so it shares the
//! ledger's write-through index and row helpers.

use super::*;
use std::collections::HashMap;

/// [`StoppedPaneRecord::kind`] of a terminal pane's stop.
pub const STOPPED_KIND_TERMINAL: &str = "terminal";
/// [`StoppedPaneRecord::kind`] of a fresh-agent pane's stop.
pub const STOPPED_KIND_FRESH_AGENT: &str = "fresh-agent";
/// [`StoppedPaneRecord::reason`] of a stop a person's kill asked for that is
/// remembered outside a unit's stop (a managed pane's stop, a start or a
/// parked create the kill cancelled, a fresh-agent pane's close): the writer
/// knows the kill was honoured, not which gesture asked for it. A unit
/// stop's record carries that stop's own reason.
pub const STOPPED_REASON_KILL: &str = "kill";

/// One stop of a pane. At least one of `terminal_id` and
/// `create_request_id` is present (a fresh-agent record always has its
/// createRequestId; its conversation is informational).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedPaneRecord {
    pub ledger_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// [`STOPPED_KIND_TERMINAL`] or [`STOPPED_KIND_FRESH_AGENT`].
    pub kind: String,
    /// The stop's final reason (`shift-x`, `cleanup`, `agent-exited`, ...).
    pub reason: String,
    pub stopped_at_ms: i64,
}

impl StoppedPaneRecord {
    /// A terminal pane's stop (its terminal id when it bound one, its
    /// createRequestId when known; the conversation is informational).
    pub fn terminal(
        terminal_id: Option<String>,
        create_request_id: Option<String>,
        provider: Option<String>,
        session_id: Option<String>,
        reason: &str,
        stopped_at_ms: i64,
    ) -> Self {
        Self {
            ledger_version: LEDGER_VERSION,
            terminal_id,
            create_request_id,
            provider,
            session_id,
            kind: STOPPED_KIND_TERMINAL.to_string(),
            reason: reason.to_string(),
            stopped_at_ms,
        }
    }

    /// The close of a fresh-agent pane: the createRequestId of the pane a
    /// person closed, and its conversation (informational).
    pub fn fresh_agent(
        provider: &str,
        session_id: &str,
        create_request_id: String,
        reason: &str,
        stopped_at_ms: i64,
    ) -> Self {
        Self {
            ledger_version: LEDGER_VERSION,
            terminal_id: None,
            create_request_id: Some(create_request_id),
            provider: Some(provider.to_string()),
            session_id: Some(session_id.to_string()),
            kind: STOPPED_KIND_FRESH_AGENT.to_string(),
            reason: reason.to_string(),
            stopped_at_ms,
        }
    }

    /// The record's file key: the terminal id when bound, else
    /// `crq-<createRequestId>`. `None` when the record names no pane (a stop
    /// is found by its terminal or createRequestId only, never by its
    /// conversation).
    pub fn key(&self) -> Option<String> {
        let present = |value: &Option<String>| value.clone().filter(|v| !v.is_empty());
        if let Some(terminal_id) = present(&self.terminal_id) {
            return Some(terminal_id);
        }
        present(&self.create_request_id).map(|create_request_id| format!("crq-{create_request_id}"))
    }
}

/// The in-memory image of the `stopped-panes/` subtree, indexed by terminal
/// id and by createRequestId (each index names record keys).
#[derive(Default)]
pub(super) struct StoppedPanes {
    by_key: HashMap<String, StoppedPaneRecord>,
    by_terminal: HashMap<String, String>,
    by_create_request: HashMap<String, String>,
}

impl StoppedPanes {
    /// Adds (or, for the same key, replaces) one record.
    pub(super) fn insert(&mut self, key: String, record: StoppedPaneRecord) {
        self.remove(&key);
        if let Some(terminal_id) = record.terminal_id.clone() {
            self.by_terminal.insert(terminal_id, key.clone());
        }
        if let Some(create_request_id) = record.create_request_id.clone() {
            self.by_create_request
                .insert(create_request_id, key.clone());
        }
        self.by_key.insert(key, record);
    }

    fn remove(&mut self, key: &str) {
        let Some(old) = self.by_key.remove(key) else {
            return;
        };
        if let Some(terminal_id) = old.terminal_id.as_deref() {
            if self.by_terminal.get(terminal_id).map(String::as_str) == Some(key) {
                self.by_terminal.remove(terminal_id);
            }
        }
        if let Some(create_request_id) = old.create_request_id.as_deref() {
            if self
                .by_create_request
                .get(create_request_id)
                .map(String::as_str)
                == Some(key)
            {
                self.by_create_request.remove(create_request_id);
            }
        }
    }

    fn for_terminal(&self, terminal_id: &str) -> Option<&StoppedPaneRecord> {
        self.by_key.get(self.by_terminal.get(terminal_id)?)
    }

    fn for_create_request(&self, create_request_id: &str) -> Option<&StoppedPaneRecord> {
        self.by_key
            .get(self.by_create_request.get(create_request_id)?)
    }
}

impl PaneLedger {
    /// `stopped-panes/`.
    pub(super) fn stopped_pane_dir(root: &Path) -> PathBuf {
        root.join("stopped-panes")
    }

    fn stopped_pane_path(root: &Path, key: &str) -> PathBuf {
        Self::stopped_pane_dir(root).join(format!("{}.json", encode_segment(key)))
    }

    /// Construction-time load of the `stopped-panes/` subtree into `index`
    /// (the `load_index` fault policy: a region that exists but cannot be
    /// listed is a store fault; an unreadable row is logged by `unreadable`
    /// and absent; an unparsable or other-version row is skipped silently
    /// for the boot scan to quarantine).
    pub(super) fn load_stopped_panes(
        root: &Path,
        index: &mut LedgerIndex,
        unreadable: &dyn Fn(&Path, &RowLoadError),
    ) -> std::io::Result<()> {
        for path in Self::flat_row_files(&Self::stopped_pane_dir(root))? {
            match load_row::<StoppedPaneRecord>(&path) {
                Ok(record) if record.ledger_version == LEDGER_VERSION => {
                    if let Some(key) = record.key() {
                        index.stopped_panes.insert(key, record);
                    }
                }
                Ok(_) | Err(RowLoadError::Missing) | Err(RowLoadError::Parse(_)) => {}
                Err(err @ RowLoadError::Io(_)) => unreadable(&path, &err),
            }
        }
        Ok(())
    }

    /// Durably remembers one stop of a pane: the record's file is written
    /// (fsynced) before the in-memory index answers it. A disabled ledger
    /// stores nothing (`Ok`). A record that names no pane is refused
    /// (`InvalidInput`). Async callers run it on a blocking thread.
    pub fn record_stopped_pane(&self, record: &StoppedPaneRecord) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let key = record.key().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "a stopped-pane record must name a terminal or a createRequestId",
            )
        })?;
        let mut index = self.guard();
        write_row_atomic(&Self::stopped_pane_path(root, &key), record)?;
        index.stopped_panes.insert(key, record.clone());
        Ok(())
    }

    /// The stop remembered for this terminal id. Memory-only.
    pub fn stopped_pane_for_terminal(&self, terminal_id: &str) -> Option<StoppedPaneRecord> {
        self.root.as_ref()?;
        self.guard()
            .stopped_panes
            .for_terminal(terminal_id)
            .cloned()
    }

    /// The stop remembered for this createRequestId. Memory-only.
    pub fn stopped_pane_for_create_request(
        &self,
        create_request_id: &str,
    ) -> Option<StoppedPaneRecord> {
        self.root.as_ref()?;
        self.guard()
            .stopped_panes
            .for_create_request(create_request_id)
            .cloned()
    }
}
