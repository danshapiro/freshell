//! Bounded attention marks for same-page WebSocket reconnects. No guard is
//! held across an await. Marks survive an unrequested runtime death so a
//! disconnected browser can still learn that its turn ended.

use std::collections::BTreeMap;
use std::sync::Mutex;

const DEFAULT_CAPACITY: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttentionMark {
    pub session_id: String,
    pub session_type: String,
    pub last_turn_complete_at: Option<i64>,
    pub last_waiting_at: Option<i64>,
}

struct Entry {
    mark: AttentionMark,
    group: u64,
    touched: u64,
}

#[derive(Default)]
struct Inner {
    entries: BTreeMap<String, Entry>,
    touch: u64,
}

pub struct AttentionLedger {
    inner: Mutex<Inner>,
    capacity: usize,
}

impl Default for AttentionLedger {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl AttentionLedger {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            capacity,
        }
    }

    pub fn observe(&self, id: &str, session_type: &str) {
        self.update(id, session_type, |_| {});
    }

    pub fn record_turn_complete(&self, id: &str, session_type: &str, at: i64) {
        self.update(id, session_type, |mark| {
            mark.last_turn_complete_at = mark.last_turn_complete_at.max(Some(at));
        });
    }

    pub fn record_waiting(&self, id: &str, session_type: &str, at: i64) {
        self.update(id, session_type, |mark| {
            mark.last_waiting_at = mark.last_waiting_at.max(Some(at));
        });
    }

    fn update(&self, id: &str, session_type: &str, update: impl Fn(&mut AttentionMark)) {
        if self.capacity == 0 {
            return;
        }
        let mut inner = self.inner.lock().expect("attention ledger lock");
        inner.touch += 1;
        let touch = inner.touch;
        let group = inner
            .entries
            .entry(id.to_string())
            .or_insert_with(|| Entry {
                mark: AttentionMark {
                    session_id: id.to_string(),
                    session_type: session_type.to_string(),
                    last_turn_complete_at: None,
                    last_waiting_at: None,
                },
                group: touch,
                touched: touch,
            })
            .group;
        for entry in inner
            .entries
            .values_mut()
            .filter(|entry| entry.group == group)
        {
            entry.mark.session_type = session_type.to_string();
            update(&mut entry.mark);
            entry.touched = touch;
        }
        Self::trim(&mut inner, self.capacity);
    }

    pub fn clear_waiting(&self, id: &str) {
        let mut inner = self.inner.lock().expect("attention ledger lock");
        let Some(group) = inner.entries.get(id).map(|entry| entry.group) else {
            return;
        };
        inner.touch += 1;
        let touch = inner.touch;
        for entry in inner
            .entries
            .values_mut()
            .filter(|entry| entry.group == group)
        {
            entry.mark.last_waiting_at = None;
            entry.touched = touch;
        }
    }

    /// Keep both envelope ids addressable. Later edges and control responses
    /// update the whole alias group, including panes that missed the rekey.
    pub fn alias(&self, from: &str, to: &str) {
        let mut inner = self.inner.lock().expect("attention ledger lock");
        let Some(source) = inner.entries.get(from) else {
            return;
        };
        let mut mark = source.mark.clone();
        let source_group = source.group;
        let target_group = inner.entries.get(to).map(|entry| {
            mark.last_turn_complete_at = mark
                .last_turn_complete_at
                .max(entry.mark.last_turn_complete_at);
            mark.last_waiting_at = mark.last_waiting_at.max(entry.mark.last_waiting_at);
            entry.group
        });
        inner.touch += 1;
        let touch = inner.touch;
        for entry in inner
            .entries
            .values_mut()
            .filter(|entry| entry.group == source_group || Some(entry.group) == target_group)
        {
            entry.group = source_group;
            entry.touched = touch;
            entry.mark.last_turn_complete_at = mark.last_turn_complete_at;
            entry.mark.last_waiting_at = mark.last_waiting_at;
        }
        mark.session_id = to.to_string();
        inner.entries.insert(
            to.to_string(),
            Entry {
                mark,
                group: source_group,
                touched: touch,
            },
        );
        Self::trim(&mut inner, self.capacity);
    }

    /// A requested close forgets every envelope for that conversation.
    pub fn forget(&self, id: &str) {
        let mut inner = self.inner.lock().expect("attention ledger lock");
        if let Some(group) = inner.entries.get(id).map(|entry| entry.group) {
            inner.entries.retain(|_, entry| entry.group != group);
        }
    }

    pub fn snapshot(&self) -> Vec<AttentionMark> {
        self.inner
            .lock()
            .expect("attention ledger lock")
            .entries
            .values()
            .map(|entry| entry.mark.clone())
            .collect()
    }

    /// Identities joined by an actual materialization edge. A missing identity
    /// has no candidates; unrelated retained conversations are never a fallback.
    pub(crate) fn aliases_for(&self, id: &str) -> Vec<String> {
        let inner = self.inner.lock().expect("attention ledger lock");
        let Some(group) = inner.entries.get(id).map(|entry| entry.group) else {
            return Vec::new();
        };
        inner
            .entries
            .values()
            .filter(|entry| entry.group == group)
            .map(|entry| entry.mark.session_id.clone())
            .collect()
    }

    fn trim(inner: &mut Inner, capacity: usize) {
        while inner.entries.len() > capacity {
            let oldest_group = inner
                .entries
                .values()
                .min_by_key(|entry| entry.touched)
                .map(|entry| entry.group)
                .expect("non-empty ledger");
            // An alias must not outlive the id used by a requested close.
            // Removing the whole group keeps forget/rekey coherent at capacity.
            inner.entries.retain(|_, entry| entry.group != oldest_group);
        }
    }
}

impl crate::claude_edges::AttentionObserver for AttentionLedger {
    fn on_registered(&self, id: &str, session_type: &str) {
        self.observe(id, session_type);
    }
    fn on_turn_complete(&self, id: &str, session_type: &str, at: i64) {
        self.record_turn_complete(id, session_type, at);
    }
    fn on_waiting(&self, id: &str, session_type: &str, at: i64) {
        self.record_waiting(id, session_type, at);
    }
    fn on_pending_drained(&self, id: &str) {
        self.clear_waiting(id);
    }
    fn on_rekeyed(&self, old: &str, new: &str) {
        self.alias(old, new);
    }
    fn on_forgotten(&self, id: &str) {
        self.forget(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_monotonic_marks_and_drains_only_waiting() {
        let ledger = AttentionLedger::with_capacity(4);
        ledger.observe("session", "kilroy");
        assert_eq!(
            ledger.snapshot(),
            vec![AttentionMark {
                session_id: "session".into(),
                session_type: "kilroy".into(),
                last_turn_complete_at: None,
                last_waiting_at: None,
            }]
        );
        ledger.record_turn_complete("session", "kilroy", 100);
        ledger.record_turn_complete("session", "kilroy", 99);
        ledger.record_waiting("session", "kilroy", 101);
        ledger.record_waiting("session", "kilroy", 98);
        assert_eq!(ledger.snapshot()[0].last_turn_complete_at, Some(100));
        assert_eq!(ledger.snapshot()[0].last_waiting_at, Some(101));
        ledger.clear_waiting("session");
        assert_eq!(ledger.snapshot()[0].last_turn_complete_at, Some(100));
        assert_eq!(ledger.snapshot()[0].last_waiting_at, None);
    }

    #[test]
    fn copies_aliases_and_merges_existing_target_marks() {
        let ledger = AttentionLedger::with_capacity(4);
        ledger.record_turn_complete("old", "freshclaude", 100);
        ledger.record_waiting("old", "freshclaude", 90);
        ledger.record_turn_complete("durable", "freshclaude", 110);
        ledger.alias("old", "durable");
        let marks = ledger.snapshot();
        assert_eq!(marks.len(), 2);
        assert_eq!(marks[0].session_id, "durable");
        assert_eq!(marks[0].last_turn_complete_at, Some(110));
        assert_eq!(marks[0].last_waiting_at, Some(90));
        assert_eq!(marks[1].last_turn_complete_at, Some(110));
        ledger.clear_waiting("durable");
        assert!(ledger
            .snapshot()
            .iter()
            .all(|mark| mark.last_waiting_at.is_none()));
        ledger.record_turn_complete("durable", "freshclaude", 120);
        assert!(ledger
            .snapshot()
            .iter()
            .all(|mark| mark.last_turn_complete_at == Some(120)));
        ledger.forget("old");
        assert!(ledger.snapshot().is_empty());
    }

    #[test]
    fn evicts_least_recently_touched_without_snapshot_refreshing_lru() {
        let ledger = AttentionLedger::with_capacity(2);
        ledger.observe("a", "freshclaude");
        ledger.observe("b", "freshclaude");
        ledger.observe("a", "freshclaude");
        ledger.snapshot();
        ledger.observe("c", "freshclaude");
        assert_eq!(
            ledger
                .snapshot()
                .iter()
                .map(|mark| mark.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "c"]
        );
    }

    #[test]
    fn eviction_keeps_alias_groups_consistent_for_a_later_requested_close() {
        let ledger = AttentionLedger::with_capacity(3);
        ledger.record_turn_complete("z-legacy", "freshclaude", 100);
        ledger.alias("z-legacy", "a-durable");
        ledger.observe("other-1", "freshclaude");
        ledger.observe("other-2", "freshclaude");
        // The canonical id sorts first among equally old aliases. Evicting
        // just that entry would leave a legacy mark which forget cannot find.
        ledger.forget("a-durable");
        let remaining: Vec<String> = ledger
            .snapshot()
            .into_iter()
            .map(|mark| mark.session_id)
            .collect();
        assert_eq!(remaining, vec!["other-1", "other-2"]);
    }

    #[test]
    fn zero_capacity_and_unknown_controls_do_not_add_entries() {
        let ledger = AttentionLedger::with_capacity(0);
        ledger.observe("session", "freshclaude");
        ledger.record_turn_complete("session", "freshclaude", 1);
        assert!(ledger.snapshot().is_empty());
        let ledger = AttentionLedger::with_capacity(2);
        ledger.clear_waiting("unknown");
        ledger.alias("unknown", "other");
        ledger.forget("unknown");
        assert!(ledger.snapshot().is_empty());
    }
}
