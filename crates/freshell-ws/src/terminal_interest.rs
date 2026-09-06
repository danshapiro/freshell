//! Connection-local presentation interest. It changes delivery order only.
//! Omitted terminals in an authoritative snapshot are background terminals;
//! before the first snapshot, the existing attach.priority is the fallback.

use super::delivery::Priority;
use freshell_protocol::client_messages::TerminalInterest;
use std::collections::{BTreeMap, BTreeSet};

pub(super) const MAX_INTEREST_TERMINALS: usize = 1024;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(super) struct InterestState {
    enabled: bool,
    revision: Option<u64>,
    focused: Option<String>,
    visible: BTreeSet<String>,
    attachments: BTreeMap<String, Priority>,
}

impl InterestState {
    pub(super) fn enable(&mut self) {
        self.enabled = true;
    }
    pub(super) fn priority(&self, terminal_id: &str) -> Priority {
        if self.revision.is_some() {
            if self.focused.as_deref() == Some(terminal_id) {
                Priority::Focused
            } else if self.visible.contains(terminal_id) {
                Priority::Visible
            } else {
                Priority::Background
            }
        } else {
            self.attachments
                .get(terminal_id)
                .copied()
                .unwrap_or(Priority::Visible)
        }
    }
    /// Pre-snapshot fallback priority. Once a snapshot revision is
    /// authoritative the map is never consulted, so attach writes nothing.
    /// The cap is a memory bound, not a security boundary: on overflow the
    /// entry is skipped (that terminal then classifies as the Visible default
    /// — the pre-feature behavior) instead of killing the connection.
    /// Entries are pruned on detach and on exit admission, so steady-state
    /// size tracks live terminals.
    pub(super) fn attach(&mut self, terminal_id: &str, background: bool) {
        if self.revision.is_some() {
            return;
        }
        if !self.attachments.contains_key(terminal_id)
            && self.attachments.len() >= MAX_INTEREST_TERMINALS
        {
            tracing::warn!(terminal_id, "ws.interest.fallback_cap_reached");
            return;
        }
        self.attachments.insert(
            terminal_id.to_string(),
            if background {
                Priority::Background
            } else {
                Priority::Visible
            },
        );
    }
    pub(super) fn detach(&mut self, terminal_id: &str) {
        self.attachments.remove(terminal_id);
    }
    pub(super) fn apply(&mut self, snapshot: &TerminalInterest) -> Result<bool, &'static str> {
        if !self.enabled {
            return Err("terminalInterestV1 was not negotiated");
        }
        if snapshot.revision == 0 || snapshot.revision > MAX_SAFE_REVISION {
            return Err("Invalid terminal interest revision");
        }
        if snapshot.visible_terminal_ids.len() > MAX_INTEREST_TERMINALS {
            return Err("Too many visible terminal identifiers");
        }
        let valid_id = |id: &str| !id.is_empty() && id.encode_utf16().count() <= 512;
        if !snapshot.visible_terminal_ids.iter().all(|id| valid_id(id))
            || snapshot
                .focused_terminal_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
        {
            return Err("Invalid terminal interest identifier");
        }
        let visible: BTreeSet<String> = snapshot.visible_terminal_ids.iter().cloned().collect();
        if snapshot
            .focused_terminal_id
            .as_ref()
            .is_some_and(|id| !visible.contains(id))
        {
            return Err("Focused terminal must be visible");
        }
        if self
            .revision
            .is_some_and(|revision| snapshot.revision <= revision)
        {
            return Ok(false);
        }
        self.revision = Some(snapshot.revision);
        self.focused.clone_from(&snapshot.focused_terminal_id);
        self.visible = visible;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(revision: u64, focused: Option<&str>, visible: &[&str]) -> TerminalInterest {
        TerminalInterest {
            revision,
            focused_terminal_id: focused.map(str::to_string),
            visible_terminal_ids: visible.iter().map(|s| s.to_string()).collect(),
        }
    }
    #[test]
    fn requires_negotiation() {
        assert!(InterestState::default()
            .apply(&snapshot(1, None, &[]))
            .is_err());
    }
    #[test]
    fn existing_attach_priority_is_honored_without_new_client() {
        let mut state = InterestState::default();
        state.attach("a", true);
        assert_eq!(state.priority("a"), Priority::Background);
        state.attach("a", false);
        assert_eq!(state.priority("a"), Priority::Visible);
    }
    #[test]
    fn full_snapshot_is_authoritative_and_newer_revision_wins() {
        let mut state = InterestState::default();
        state.enable();
        assert_eq!(state.apply(&snapshot(3, Some("a"), &["a", "b"])), Ok(true));
        assert_eq!(state.priority("a"), Priority::Focused);
        assert_eq!(state.priority("b"), Priority::Visible);
        assert_eq!(state.priority("c"), Priority::Background);
        assert_eq!(state.apply(&snapshot(2, Some("b"), &["b"])), Ok(false));
        assert_eq!(state.priority("a"), Priority::Focused);
        assert_eq!(state.apply(&snapshot(4, None, &[])), Ok(true));
        assert_eq!(state.priority("a"), Priority::Background);
    }
    #[test]
    fn priority_does_not_allocate_terminal_output_or_transfer_connections() {
        let mut first = InterestState::default();
        first.enable();
        first
            .apply(&snapshot(1, Some("not-attached"), &["not-attached"]))
            .unwrap();
        assert!(first.attachments.is_empty());
        let second = InterestState::default();
        assert_eq!(second.priority("not-attached"), Priority::Visible);
    }
    #[test]
    fn rejects_malformed_snapshot_without_replacing_previous_state() {
        let mut state = InterestState::default();
        state.enable();
        state.apply(&snapshot(1, Some("a"), &["a"])).unwrap();
        for invalid in [
            snapshot(0, None, &[]),
            snapshot(MAX_SAFE_REVISION + 1, None, &[]),
            snapshot(2, Some("b"), &["a"]),
            snapshot(2, None, &[""]),
        ] {
            assert!(state.apply(&invalid).is_err());
            assert_eq!(state.priority("a"), Priority::Focused);
        }
    }
    #[test]
    fn detach_prunes_fallback_and_snapshot_does_not_override_live_identity() {
        let mut state = InterestState::default();
        state.attach("old", true);
        state.detach("old");
        assert!(state.attachments.is_empty());
        state.enable();
        state.apply(&snapshot(1, Some("old"), &["old"])).unwrap();
        assert_eq!(state.priority("replacement"), Priority::Background);
    }
}
