//! Applying a decided automatic name (name-reliability plan, Task 4): the
//! small document mutations the store's decisions use once
//! `session_name_policy` has decided an offer applies — install the name
//! exactly as planned (never re-offered through the strict raise) and
//! attach a rename outcome. (A record's native baseline is read through
//! `session_name_sweep_batch::StagedNativeBaselines`; every accepted change,
//! self-heals included, is logged by `session_name_events`.)

use freshell_protocol::session_names::{
    NameSource, RenameOutcome, SessionNameRecord, SessionNameRef, SessionNameUpdate,
};

use super::{name_ref_key, Decision, NameError, StoredDocument};
use crate::session_name_generation::IndexedNameInput;

/// Name-reliability Task 4: install an automatic name the policy already
/// decided (`session_name_policy`) — no rank check here, so a planned
/// equal-rank replacement (a self-heal, an automation rename) applies exactly
/// as planned instead of being re-offered through `offer_mut`'s strict
/// raise (C1). Never used for manual names.
pub(super) fn replace_automatic(
    document: &mut StoredDocument,
    key: &str,
    name: String,
    source: NameSource,
) -> Result<(), NameError> {
    debug_assert!(
        source != NameSource::Manual,
        "manual names go through offer_mut"
    );
    let Some(record) = document.record_at(key).cloned() else {
        return Err(NameError::NotFound(format!("no naming record for {key}")));
    };
    let revision = document.allocate_revision()?;
    document.records.insert(
        key.to_string(),
        SessionNameRecord {
            name_ref: record.name_ref,
            name,
            source,
            revision,
            manual_revision: None,
            renamed_at: None,
            legacy_origin: None,
        },
    );
    Ok(())
}

/// A source as the stored document and the wire spell it (`provider_ai`,
/// `directory`), taken from its serde form so a log line matches a search
/// for that spelling.
pub(super) fn wire_source(source: NameSource) -> String {
    serde_json::to_value(source)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{source:?}"))
}

/// The durable session key an index row names.
pub(super) fn indexed_key(input: &IndexedNameInput) -> String {
    name_ref_key(&SessionNameRef::Session {
        provider: input.provider,
        session_id: input.session_id.clone(),
    })
}

/// Attach a rename outcome to a rename decision's answer (only rename
/// responses carry one; the publish list never does).
pub(super) fn with_outcome(
    decision: Decision<SessionNameUpdate>,
    outcome: RenameOutcome,
) -> Decision<SessionNameUpdate> {
    match decision {
        Decision::Read(mut update) => {
            update.outcome = Some(outcome);
            Decision::Read(update)
        }
        Decision::Write { mut value, publish } => {
            value.outcome = Some(outcome);
            Decision::Write { value, publish }
        }
    }
}
