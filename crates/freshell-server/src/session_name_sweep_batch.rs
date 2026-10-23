//! Batched sweep maintenance (name-reliability plan, Task 4; LB-B1).
//!
//! Every store transaction re-reads and rewrites the whole name document
//! under a lock that waiters poll for at most one second. Right after the
//! self-heal rule deploys, about 190 junk names heal in the first sweep
//! passes; as one transaction each they could starve user renames and binds.
//! So the sweep collects its MAINTENANCE work — self-heal replacements found
//! by the activity or hydration pre-checks, and the native baselines the
//! store staged in memory — and applies it in ONE transaction per pass that
//! covers at most [`SWEEP_MAINTENANCE_BATCH`] records. Work beyond that waits
//! for the next pass (at least 5 s later), so renames and binds take the lock
//! between passes. Inserts of new records and activities that arm
//! generation keep their own per-row transactions: they are new work, not
//! maintenance.
//!
//! The batch re-plans every item on the freshly read document with the same
//! plan functions the per-row transactions use, so an item whose record
//! moved since the pre-check (a user rename, a foreign process) applies
//! exactly what the current document allows.

use std::collections::BTreeMap;
use std::sync::Mutex;

use freshell_freshagent::naming::{NameActivity, NameError};

use super::session_name_events::{NameChangeCause, NameChangeEvent};
use super::session_name_policy::{plan_hydrate, HydratePlan};
use super::{Decision, PublishSpec, StoredDocument, TxnMeta};
use crate::session_name_generation::IndexedNameInput;

/// One maintenance transaction covers at most this many records.
pub(crate) const SWEEP_MAINTENANCE_BATCH: usize = 25;

/// What a sweep pre-check says about one row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SweepWork {
    /// The view proves the transaction would be a no-op Read.
    None,
    /// New work (an insert, an arm, a first raise): its own transaction now.
    Immediate,
    /// A self-heal replacement only: it rides the pass's maintenance batch.
    Maintenance,
}

/// One record's maintenance work, as the sweep row reported it. Both parts
/// are optional; the batch applies the hydration heal first, then the
/// activity (re-planned on the document the heal left).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SweepMaintenanceItem {
    pub hydrate: Option<IndexedNameInput>,
    pub activity: Option<NameActivity>,
}

/// What one maintenance transaction did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SweepMaintenanceReport {
    /// Records whose saved name the batch replaced.
    pub healed: usize,
    /// Staged native baselines the batch persisted.
    pub baselines: usize,
    /// Items beyond the batch size, left for a later pass.
    pub deferred: usize,
}

/// One staged baseline: the title, and the persisted baseline the
/// observation saw when it staged it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StagedBaseline {
    title: String,
    over: Option<String>,
}

/// The native baselines observed but not yet persisted: an observation
/// whose only effect is a new baseline never makes its own commit. Keyed by
/// record key; decisions read a staged value as if it were persisted. Lost
/// on restart, which only means the next observation records it again.
///
/// A staged value is this process's newest observation, but only relative
/// to the persisted baseline it was staged over: once another process
/// persists a different baseline, that one is newer, and the staged value
/// is dropped — never read, never written back over it (writing it back
/// would make the provider's next re-report of the newer title look
/// changed and undo a rename made since).
#[derive(Debug, Default)]
pub(super) struct StagedNativeBaselines(Mutex<BTreeMap<String, StagedBaseline>>);

/// The persisted baseline of `key` in `document`.
fn persisted<'a>(document: &'a StoredDocument, key: &str) -> Option<&'a str> {
    document
        .native_write
        .get(key)
        .and_then(|state| state.last_native_title.as_deref())
}

impl StagedNativeBaselines {
    fn map(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, StagedBaseline>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The staged title, whatever the document holds (a test seam).
    #[cfg(test)]
    pub(super) fn title(&self, key: &str) -> Option<String> {
        self.map().get(key).map(|staged| staged.title.clone())
    }

    /// The baseline decisions use for `key`: the staged title while the
    /// document still holds the baseline it was staged over, else the
    /// persisted one.
    pub(super) fn effective(&self, document: &StoredDocument, key: &str) -> Option<String> {
        let persisted = persisted(document, key);
        self.map()
            .get(key)
            .filter(|staged| staged.over.as_deref() == persisted)
            .map(|staged| staged.title.clone())
            .or_else(|| persisted.map(str::to_string))
    }

    /// Stage `title` over the document's persisted baseline for `key`.
    pub(super) fn stage(&self, document: &StoredDocument, key: &str, title: String) {
        let over = persisted(document, key).map(str::to_string);
        let mut map = self.map();
        if over.as_deref() == Some(title.as_str()) {
            // The persisted baseline already is this title.
            map.remove(key);
        } else {
            map.insert(key.to_string(), StagedBaseline { title, over });
        }
    }

    pub(super) fn remove(&self, key: &str) {
        self.map().remove(key);
    }

    pub(super) fn is_empty(&self) -> bool {
        self.map().is_empty()
    }

    fn first(&self, count: usize) -> Vec<(String, StagedBaseline)> {
        self.map()
            .iter()
            .take(count)
            .map(|(key, staged)| (key.clone(), staged.clone()))
            .collect()
    }

    /// Drop every staged baseline the document already carries, every one
    /// another participant superseded (the persisted baseline is no longer
    /// the one it was staged over), and every one whose record no longer
    /// exists (a bound pending handle). Called with each freshly committed
    /// or adopted document.
    pub(super) fn prune_persisted(&self, document: &StoredDocument) {
        let mut map = self.map();
        if map.is_empty() {
            return;
        }
        map.retain(|key, staged| {
            let persisted = persisted(document, key);
            document.records.contains_key(key)
                && persisted == staged.over.as_deref()
                && persisted != Some(staged.title.as_str())
        });
    }
}

/// The batch transaction. Applies at most [`SWEEP_MAINTENANCE_BATCH`]
/// items, then fills the remaining room with staged baselines; publishes
/// every record whose name changed. A Read when nothing changed.
pub(super) fn sweep_maintenance_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    items: Vec<SweepMaintenanceItem>,
) -> Result<Decision<SweepMaintenanceReport>, NameError> {
    let mut report = SweepMaintenanceReport {
        deferred: items.len().saturating_sub(SWEEP_MAINTENANCE_BATCH),
        ..SweepMaintenanceReport::default()
    };
    let mut publish: Vec<PublishSpec> = Vec::new();
    let mut wrote = false;
    let mut used = 0usize;
    for item in items.into_iter().take(SWEEP_MAINTENANCE_BATCH) {
        used += 1;
        let mut healed: Option<(String, NameChangeEvent)> = None;
        if let Some(input) = item.hydrate {
            // Only the heal half of hydration is maintenance; an insert
            // (the record vanished?) is left to the per-row path.
            if let Some(HydratePlan::Heal { name, source }) = plan_hydrate(document, &input) {
                let key = super::indexed_key(&input);
                let change = NameChangeEvent::new(
                    NameChangeCause::Hydrate,
                    document.record_at(&key),
                    input.cwd.as_deref(),
                );
                super::replace_automatic(document, &key, name, source)?;
                healed = Some((key, change));
            }
        }
        if let Some(activity) = item.activity {
            match super::apply_activity(document, activity) {
                Ok(applied) => {
                    wrote |= applied.bookkeeping;
                    if let Some(change) = applied.change {
                        // The same record healed by hydration first: log one
                        // change from where the hydration started.
                        let earlier = healed
                            .take()
                            .and_then(|(key, earlier)| (key == applied.key).then_some(earlier));
                        healed = Some((applied.key, change.after(earlier)));
                    }
                }
                // A row whose record is gone has nothing to heal.
                Err(NameError::NotFound(_)) => {}
                Err(error) => return Err(error),
            }
        }
        if let Some((key, change)) = healed {
            report.healed += 1;
            wrote = true;
            // One publish (and one logged change) per record: a record an
            // earlier item already changed keeps that item's starting point.
            match publish.iter_mut().find(|spec| spec.key == key) {
                Some(spec) => spec.change = Some(change.after(spec.change.take())),
                None => publish.push(PublishSpec::changed(key, change)),
            }
        }
    }
    let room = SWEEP_MAINTENANCE_BATCH.saturating_sub(used);
    for (key, staged) in meta.staged_baselines.first(room) {
        if !document.records.contains_key(&key) {
            meta.staged_baselines.remove(&key);
            continue;
        }
        // Another participant persisted a different baseline since this
        // one was staged: theirs is newer, so the staged one is dropped.
        if persisted(document, &key) != staged.over.as_deref() {
            tracing::debug!(
                target: "freshell_server::session_names",
                op = "sweep_maintenance",
                name_ref = %key,
                "session_names.native_baseline_superseded"
            );
            meta.staged_baselines.remove(&key);
            continue;
        }
        let entry = document.native_write.entry(key).or_default();
        if entry.last_native_title.as_deref() != Some(staged.title.as_str()) {
            entry.last_native_title = Some(staged.title);
            wrote = true;
        }
        report.baselines += 1;
    }
    if report.healed + report.baselines > 0 || report.deferred > 0 {
        tracing::info!(
            target: "freshell_server::session_names",
            op = "sweep_maintenance",
            healed = report.healed,
            baselines = report.baselines,
            deferred = report.deferred,
            "session_names.sweep_maintenance"
        );
    }
    if wrote {
        Ok(Decision::Write {
            value: report,
            publish,
        })
    } else {
        Ok(Decision::Read(report))
    }
}

/// The sweep pass's collector: at most one batch of maintenance items per
/// pass (the rest is found again by the next pass's pre-checks).
#[derive(Debug, Default)]
pub(crate) struct SweepMaintenanceQueue {
    items: Vec<SweepMaintenanceItem>,
}

impl SweepMaintenanceQueue {
    /// Queue one record's maintenance work; `false` when the batch is full.
    pub(crate) fn push(&mut self, item: SweepMaintenanceItem) -> bool {
        if self.items.len() >= SWEEP_MAINTENANCE_BATCH {
            return false;
        }
        self.items.push(item);
        true
    }

    pub(crate) fn into_items(self) -> Vec<SweepMaintenanceItem> {
        self.items
    }
}

#[cfg(test)]
#[path = "session_name_sweep_batch_tests.rs"]
mod tests;
