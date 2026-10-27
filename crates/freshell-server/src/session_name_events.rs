//! Name-reliability Task 12 (D11): one structured INFO line per accepted
//! saved-name change, so a name's history can be rebuilt from the log.
//!
//! A store decision that changes a record attaches a [`NameChangeEvent`] to
//! the record's publish entry: why it changed (the [`NameChangeCause`]) and
//! the record as it stood before the decision touched it. After the durable
//! replace succeeds, the transaction runner hands those entries to
//! [`log_name_changes`], which writes `session_names.name_changed` for each
//! record whose saved name visibly changed: the record is new, or its name
//! or source differs from before. A failed commit logs nothing; a decision
//! that changes only bookkeeping (a generation advance, a native status)
//! attaches no event. Changes another process committed are logged once
//! when this store adopts them ([`AdoptedChanges`], cause
//! `adopted_external`) — never for the document this store loads at open.
//! A commit whose durable replace ends uncertain (the replacement landed,
//! its durability is unproven) logs nothing when it is made; the next
//! transaction that reconciles and adopts or commits over that document
//! logs its changes with their own causes ([`UncertainCommits`]), so this
//! store's own change is never reported as another process's.
//!
//! The line carries the record key (`name_ref`), the old and new name,
//! source and revision (the old ones are absent when the record is new),
//! the cause, the self-heal flag, and `from_ref` / `import_id` /
//! `evidence_key` / `series` when they apply. Names are logged by design:
//! they are what a reader needs to rebuild a name's history, they are the
//! same text the name document and every naming surface already show, and
//! every line passes the log writer's secret scrubber. Saved names are the
//! only prompt-derived text these lines carry: a saved name is at most 200
//! characters, and a `first_message` name is the first words of the
//! session's first user message, cut to 50 characters.
//!
//! `self_heal` is true exactly when an automatic offer — a native
//! observation, a first-message fallback, the session index (`hydrate`) or
//! a bind's pending name (`bind_collision`) — replaced a self-heal record
//! (an unprotected saved name the default/derived-name classifier
//! recognizes, with the folder the offer knew) by a name whose source
//! ranks the same or lower. Outside the self-heal rule an automatic offer
//! applies only by raising the rank (or, for a provider's changed native
//! title, at equal rank over an older provider-level name), so the flag
//! marks the junk names the rule replaced. A change that raises the source
//! rank (a folder name giving way to the first message) is `false` even
//! when the replaced name was a self-heal record, whichever path made it,
//! so the same before/after pair always logs the same flag. Renames, AI
//! answers, imports and adopted external changes are always `false`.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use freshell_protocol::session_names::{NameRevision, NameSource, SessionNameRecord};

use super::session_name_apply::wire_source;
use super::session_name_policy::is_self_heal_record;
use super::{source_rank, StoredDocument};

/// Why a saved name changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NameChangeCause {
    /// The one-time legacy consolidation installed a migrated name.
    Import,
    /// A provider reported a native title.
    NativeObservation,
    /// The session's first user message became its name.
    FirstMessageFallback,
    /// Freshell AI naming answered.
    Generation,
    /// A person renamed the session.
    ManualRename,
    /// An agent or tool renamed the session without user intent.
    AutomationRename,
    /// A pending handle was bound to a durable session that had no record.
    Bind,
    /// A pending handle was bound to a durable session that had a record,
    /// and the pending record's name won.
    BindCollision,
    /// A new terminal got its pending record (the folder name).
    EnsurePending,
    /// A known session was named before its index row arrived.
    EnsureSession,
    /// An undo/redo replacement inherited its source's name once.
    InternalContinuation,
    /// The session index created or healed the session's record.
    Hydrate,
    /// Another process committed the change; this store adopted it.
    AdoptedExternal,
}

impl NameChangeCause {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Import => "import",
            Self::NativeObservation => "native_observation",
            Self::FirstMessageFallback => "first_message_fallback",
            Self::Generation => "generation",
            Self::ManualRename => "manual_rename",
            Self::AutomationRename => "automation_rename",
            Self::Bind => "bind",
            Self::BindCollision => "bind_collision",
            Self::EnsurePending => "ensure_pending",
            Self::EnsureSession => "ensure_session",
            Self::InternalContinuation => "internal_continuation",
            Self::Hydrate => "hydrate",
            Self::AdoptedExternal => "adopted_external",
        }
    }

    /// The internal `offer` seam names its offer only by source.
    pub(super) fn of_offer(source: NameSource) -> Self {
        match source {
            NameSource::Manual => Self::ManualRename,
            NameSource::FreshellAi => Self::Generation,
            NameSource::ProviderAi => Self::NativeObservation,
            NameSource::FirstMessage => Self::FirstMessageFallback,
            NameSource::Directory => Self::Hydrate,
            NameSource::LegacyProtected => Self::Import,
        }
    }

    /// The automatic offers the self-heal rule governs
    /// (`session_name_policy`). User and automation renames, AI answers and
    /// imports follow their own rules, so they never heal.
    fn can_heal(self) -> bool {
        matches!(
            self,
            Self::NativeObservation
                | Self::FirstMessageFallback
                | Self::Hydrate
                | Self::BindCollision
        )
    }
}

/// A record's saved name at one revision.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NameState {
    name: String,
    source: NameSource,
    revision: NameRevision,
}

impl NameState {
    fn of(record: &SessionNameRecord) -> Self {
        Self {
            name: record.name.clone(),
            source: record.source,
            revision: record.revision,
        }
    }

    /// The name or the source moved (a revision alone is not a visible
    /// change).
    fn differs_from(&self, other: &Self) -> bool {
        self.name != other.name || self.source != other.source
    }
}

/// The record a change replaced, captured before the decision mutated it.
#[derive(Debug, Clone)]
struct Prior {
    state: NameState,
    /// Whether the self-heal rule recognizes it as junk under the folder
    /// the deciding offer knew.
    self_heal_record: bool,
}

/// One decision's change to one record (see the module docs).
#[derive(Debug, Clone)]
pub(super) struct NameChangeEvent {
    cause: NameChangeCause,
    prior: Option<Prior>,
    from_ref: Option<String>,
    import_id: Option<String>,
    evidence_key: Option<String>,
    series: Option<String>,
}

impl NameChangeEvent {
    /// A change of `prior` (`None`: the decision creates the record). `cwd`
    /// is the folder the decision classified names with, so the self-heal
    /// flag uses the same context as the self-heal rule did.
    pub(super) fn new(
        cause: NameChangeCause,
        prior: Option<&SessionNameRecord>,
        cwd: Option<&str>,
    ) -> Self {
        Self {
            cause,
            prior: prior.map(|record| Prior {
                state: NameState::of(record),
                self_heal_record: is_self_heal_record(record, cwd),
            }),
            from_ref: None,
            import_id: None,
            evidence_key: None,
            series: None,
        }
    }

    /// The pending handle a bind moved into the record.
    pub(super) fn with_from_ref(mut self, pending_key: &str) -> Self {
        self.from_ref = Some(pending_key.to_string());
        self
    }

    /// The import and the evidence a migrated name came from.
    pub(super) fn with_import(mut self, import_id: &str, evidence_key: &str) -> Self {
        self.import_id = Some(import_id.to_string());
        self.evidence_key = Some(evidence_key.to_string());
        self
    }

    /// The generation series whose answer was accepted.
    pub(super) fn with_series(mut self, series_id: &str) -> Self {
        self.series = Some(series_id.to_string());
        self
    }

    /// This change, measured from where `earlier` — an earlier change of the
    /// same record in the same transaction — started.
    pub(super) fn after(mut self, earlier: Option<NameChangeEvent>) -> Self {
        if let Some(earlier) = earlier {
            self.prior = earlier.prior;
        }
        self
    }

    /// Whether the change replaced junk only because of the self-heal rule:
    /// an automatic offer over a self-heal record that did not outrank it
    /// (an ordinary rank raise, such as a folder name giving way to the
    /// first message, is not a heal — also when the session index made it,
    /// so the flag depends on the before/after pair, never on the path; see
    /// the module docs).
    fn heals(&self, new: &NameState) -> bool {
        self.cause.can_heal()
            && self.prior.as_ref().is_some_and(|prior| {
                prior.self_heal_record && source_rank(new.source) <= source_rank(prior.state.source)
            })
    }
}

/// One `session_names.name_changed` line waiting to be written: the record
/// key, the change, and the saved name it ends at.
type PendingLine = (String, NameChangeEvent, NameState);

/// Log the changes a committed transaction made. A record changed by more
/// than one decision in the transaction (an import with several winning
/// candidates for one session) logs once: the last change measured from
/// where the first one started ([`NameChangeEvent::after`], the same merge
/// the sweep batch applies per record), so the old name and the self-heal
/// flag are both judged against the record before the transaction.
pub(super) fn log_name_changes<'a>(
    document: &StoredDocument,
    changes: impl IntoIterator<Item = (&'a str, &'a NameChangeEvent)>,
) {
    for (key, event, new) in &change_lines(document, changes) {
        emit(key, event, new);
    }
}

/// The lines [`log_name_changes`] writes, one per changed record.
fn change_lines<'a>(
    document: &StoredDocument,
    changes: impl IntoIterator<Item = (&'a str, &'a NameChangeEvent)>,
) -> Vec<PendingLine> {
    let mut order: Vec<&str> = Vec::new();
    let mut merged: BTreeMap<&str, NameChangeEvent> = BTreeMap::new();
    for (key, event) in changes {
        let earlier = merged.remove(key);
        if earlier.is_none() {
            order.push(key);
        }
        merged.insert(key, event.clone().after(earlier));
    }
    order
        .into_iter()
        .filter_map(|key| {
            let record = document.record_at(key)?;
            let event = merged.remove(key)?;
            Some((key.to_string(), event, NameState::of(record)))
        })
        .collect()
}

/// The visible record changes between `adopted` and a newer document
/// another participant committed. Nothing when `adopted` is the pre-load
/// placeholder (generation 0: opening a store loads the document, it adopts
/// no change) or `next` is not newer.
fn adopted_external(adopted: &StoredDocument, next: &StoredDocument) -> Vec<PendingLine> {
    if adopted.document_generation == 0 || next.document_generation <= adopted.document_generation {
        return Vec::new();
    }
    next.records
        .iter()
        .filter_map(|(key, record)| {
            let old = adopted.records.get(key);
            let visible =
                old.is_none_or(|old| old.name != record.name || old.source != record.source);
            visible.then(|| {
                (
                    key.clone(),
                    NameChangeEvent::new(NameChangeCause::AdoptedExternal, old, None),
                    NameState::of(record),
                )
            })
        })
        .collect()
}

/// The name changes a transaction brings in when it reads a newer document
/// than this store's adopted view: this store's own commit whose replace
/// ended uncertain (with its own causes) and other participants' commits
/// (`adopted_external`). Captured when the transaction reads the document,
/// before its decision mutates it; written once the transaction adopts or
/// commits over that document ([`UncertainCommits::log_adopted`]).
#[derive(Debug, Default)]
pub(super) struct AdoptedChanges {
    lines: Vec<PendingLine>,
}

/// This store's own commit whose durable replace ended uncertain
/// (`NameError::CommitUncertain`: the replacement landed, its durability is
/// unproven), with the lines its transaction did not write — what that
/// transaction adopted, then its own changes.
#[derive(Debug)]
struct UncertainCommit {
    document: StoredDocument,
    digest: [u8; 32],
    lines: Vec<PendingLine>,
}

impl UncertainCommit {
    /// Whether `next`, read over the view `adopted`, holds this commit: the
    /// view is still older than it, and `next` is either these exact bytes
    /// or a later document (only built on top of them — this store held
    /// the lock when the replacement landed).
    fn is_held_by(
        &self,
        adopted: &StoredDocument,
        next: &StoredDocument,
        digest: &[u8; 32],
    ) -> bool {
        let generation = self.document.document_generation;
        adopted.document_generation < generation
            && match next.document_generation.cmp(&generation) {
                Ordering::Less => false,
                Ordering::Equal => *digest == self.digest,
                Ordering::Greater => true,
            }
    }
}

/// The store's last uncertain commit, kept until a later transaction
/// confirms the document — reconciles its durability, then adopts or
/// commits over it — and writes the commit's lines with their own causes.
/// Only what changed after it counts as another participant's.
#[derive(Debug, Default)]
pub(super) struct UncertainCommits(Mutex<Option<UncertainCommit>>);

impl UncertainCommits {
    fn slot(&self) -> MutexGuard<'_, Option<UncertainCommit>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// What adopting `next` (whose bytes hash to `digest`) over the view
    /// `adopted` brings in.
    pub(super) fn adopted_changes(
        &self,
        adopted: &StoredDocument,
        next: &StoredDocument,
        digest: &[u8; 32],
    ) -> AdoptedChanges {
        let slot = self.slot();
        let lines = match slot
            .as_ref()
            .filter(|commit| commit.is_held_by(adopted, next, digest))
        {
            Some(commit) => {
                let mut lines = commit.lines.clone();
                lines.extend(adopted_external(&commit.document, next));
                lines
            }
            None => adopted_external(adopted, next),
        };
        AdoptedChanges { lines }
    }

    /// Keep this store's commit of `document` (its bytes hash to `digest`),
    /// whose replace ended uncertain, with the lines its transaction would
    /// have written: `adopted`, then `changes`.
    pub(super) fn remember<'a>(
        &self,
        adopted: AdoptedChanges,
        document: StoredDocument,
        digest: [u8; 32],
        changes: impl IntoIterator<Item = (&'a str, &'a NameChangeEvent)>,
    ) {
        let mut lines = adopted.lines;
        lines.extend(change_lines(&document, changes));
        *self.slot() = Some(UncertainCommit {
            document,
            digest,
            lines,
        });
    }

    /// The transaction adopted or committed over the document `adopted`
    /// was read from: write its lines and forget the uncertain commit (the
    /// view now holds a later document).
    pub(super) fn log_adopted(&self, adopted: AdoptedChanges) {
        *self.slot() = None;
        for (key, event, new) in &adopted.lines {
            emit(key, event, new);
        }
    }
}

/// Write one `session_names.name_changed` line for `event` ending at `new`:
/// the old fields and the self-heal flag both come from the event's own
/// prior record. Nothing is logged when the name and source did not move.
fn emit(key: &str, event: &NameChangeEvent, new: &NameState) {
    let old = event.prior.as_ref().map(|prior| &prior.state);
    if old.is_some_and(|old| !old.differs_from(new)) {
        return;
    }
    let old_source = old.map(|old| wire_source(old.source));
    tracing::info!(
        target: "freshell_server::session_names",
        name_ref = %key,
        cause = event.cause.as_str(),
        old_name = old.map(|old| old.name.as_str()),
        old_source = old_source.as_deref(),
        old_revision = old.map(|old| old.revision),
        new_name = new.name.as_str(),
        new_source = %wire_source(new.source),
        new_revision = new.revision,
        self_heal = event.heals(new),
        from_ref = event.from_ref.as_deref(),
        import_id = event.import_id.as_deref(),
        evidence_key = event.evidence_key.as_deref(),
        series = event.series.as_deref(),
        "session_names.name_changed"
    );
}

#[cfg(test)]
#[path = "session_name_events_tests.rs"]
mod tests;
