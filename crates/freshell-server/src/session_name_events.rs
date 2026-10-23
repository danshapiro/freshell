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
//! when this store adopts them ([`ExternalChanges`], cause
//! `adopted_external`) — never for the document this store loads at open.
//!
//! The line carries the record key (`name_ref`), the old and new name,
//! source and revision (the old ones are absent when the record is new),
//! the cause, the self-heal flag, and `from_ref` / `import_id` /
//! `evidence_key` / `series` when they apply. Names are logged by design:
//! they are what a reader needs to rebuild a name's history, they are the
//! same text the name document and every naming surface already show, and
//! every line passes the log writer's secret scrubber.

use std::collections::BTreeMap;

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
    /// first message, is not a heal).
    fn heals(&self, new: &NameState) -> bool {
        self.cause.can_heal()
            && self.prior.as_ref().is_some_and(|prior| {
                prior.self_heal_record && source_rank(new.source) <= source_rank(prior.state.source)
            })
    }
}

/// Log the changes a committed transaction made. A record changed by more
/// than one decision in the transaction (an import with several candidates
/// for one session, a sweep item that hydrated and then applied an
/// activity) logs once: from its state before the first change to its
/// committed state, under the last change's cause.
pub(super) fn log_name_changes<'a>(
    document: &StoredDocument,
    changes: impl IntoIterator<Item = (&'a str, &'a NameChangeEvent)>,
) {
    let mut order: Vec<&str> = Vec::new();
    let mut merged: BTreeMap<&str, (Option<&'a Prior>, &'a NameChangeEvent)> = BTreeMap::new();
    for (key, event) in changes {
        match merged.get_mut(key) {
            Some((_, last)) => *last = event,
            None => {
                order.push(key);
                merged.insert(key, (event.prior.as_ref(), event));
            }
        }
    }
    for key in order {
        let (prior, event) = merged[key];
        let Some(record) = document.record_at(key) else {
            continue;
        };
        emit(
            key,
            prior.map(|prior| &prior.state),
            &NameState::of(record),
            event,
        );
    }
}

/// The visible record changes between this store's adopted view and a
/// newer document another participant committed, captured when the
/// transaction read the newer document and logged once it is adopted (or
/// committed over).
#[derive(Debug, Default)]
pub(super) struct ExternalChanges {
    changes: Vec<(String, NameChangeEvent, NameState)>,
}

impl ExternalChanges {
    /// What changed from `adopted` to `next`. Nothing when `adopted` is the
    /// pre-load placeholder (generation 0: opening a store loads the
    /// document, it adopts no change) or `next` is not newer.
    pub(super) fn between(adopted: &StoredDocument, next: &StoredDocument) -> Self {
        if adopted.document_generation == 0
            || next.document_generation <= adopted.document_generation
        {
            return Self::default();
        }
        let changes = next
            .records
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
            .collect();
        Self { changes }
    }

    pub(super) fn log(&self) {
        for (key, event, new) in &self.changes {
            emit(
                key,
                event.prior.as_ref().map(|prior| &prior.state),
                new,
                event,
            );
        }
    }
}

fn emit(key: &str, old: Option<&NameState>, new: &NameState, event: &NameChangeEvent) {
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
