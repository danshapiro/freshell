//! Legacy-name import policy once the one-time consolidation is complete
//! (name-reliability plan, Task 3; decision D1, server side).
//!
//! Two rules live here, plus the envelope checks every import passes:
//!
//! 1. **Post-completion browser imports are acknowledged and change
//!    nothing.** Once `migration.completed` is committed, the browser has no
//!    genuine pre-migration evidence left to offer: what an old client still
//!    sends is its live layout (current tab titles, "Tab N", provider labels
//!    from other windows), and applying it is how saved names reverted. Every
//!    candidate id is acknowledged so the client stops resending, and nothing
//!    is written — no record is created or changed, no candidate id is
//!    stored, no backup file is written, and the document generation does
//!    not move. One INFO line per import id per process records it. The
//!    receipt never reverts, so a store whose adopted view shows it answers
//!    without the document lock or a re-read; a stale view goes through the
//!    transaction, whose decision applies the same rule.
//!
//! 2. **An import-owned default label loses a bind collision.** A record the
//!    migration installed (its winning evidence is still at the installed
//!    revision) whose source is automatic (`directory`, `first_message`,
//!    `provider_ai`) and whose name the shared classifier recognizes as a
//!    default or derived label ("Tab 4", "OpenCode agent") gives way to the
//!    live pending record being bound. Every other import-owned record — a
//!    label that looks typed by a person, a real first message, anything
//!    protected — keeps the rank rule. Bind inputs carry no folder, so only
//!    folder-free patterns are recognized here.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use freshell_protocol::session_names::{LegacyImportResult, LegacyNameImport, NameSource};

use super::{wire_source, NameError, StoredDocument, NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT};

/// The per-process set of import ids already logged as ignored is cleared
/// when it reaches this size, which bounds its memory; an id seen again after
/// a clear logs once more.
const LOGGED_IMPORT_IDS_CAPACITY: usize = 4096;

/// The envelope checks every import passes before anything else, before or
/// after completion: a supported version, a retry-stable import id, and at
/// most [`NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT`] candidates.
pub(super) fn validate_import_envelope(input: &LegacyNameImport) -> Result<(), NameError> {
    if input.version != 1 {
        return Err(NameError::InvalidName(
            "unsupported legacy-name import version".into(),
        ));
    }
    if input.import_id.trim().is_empty() {
        return Err(NameError::InvalidName(
            "a legacy-name import must carry its retry-stable importId".into(),
        ));
    }
    if input.candidates.len() > NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT {
        return Err(NameError::InvalidName(format!(
            "a legacy-name import batches at most {NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT} candidates"
        )));
    }
    Ok(())
}

/// Rule 1: the whole answer to a browser import that arrives after the
/// consolidation completed. The envelope is validated and every candidate
/// id is acknowledged (an empty id is still refused, exactly as before
/// completion); `names` is empty — no record was touched. Logs
/// `session_names.import_ignored_after_completion` once per import id per
/// process. It reads only the import itself, which is what lets the store
/// answer from its adopted view without a transaction.
pub(super) fn post_completion_acknowledge(
    input: &LegacyNameImport,
) -> Result<LegacyImportResult, NameError> {
    validate_import_envelope(input)?;
    let mut acknowledged = Vec::with_capacity(input.candidates.len());
    for candidate in &input.candidates {
        if candidate.id.trim().is_empty() {
            return Err(NameError::InvalidName(
                "a legacy-name candidate must carry its stable id".into(),
            ));
        }
        acknowledged.push(candidate.id.clone());
    }
    if first_time_logged(&input.import_id) {
        tracing::info!(
            target: "freshell_server::session_names",
            op = "import_legacy",
            import_id = %input.import_id,
            candidates = acknowledged.len(),
            "session_names.import_ignored_after_completion"
        );
    }
    Ok(LegacyImportResult {
        acknowledged,
        names: Vec::new(),
    })
}

/// Whether the record at `key` is still the one the migration installed:
/// winning evidence is retained for it and the record has not moved past the
/// revision that evidence installed.
pub(super) fn is_import_owned(document: &StoredDocument, key: &str) -> bool {
    match (
        document.record_at(key),
        document.migration.winning_evidence.get(key),
    ) {
        (Some(record), Some(evidence)) => record.revision == evidence.installed_revision,
        _ => false,
    }
}

/// Rule 2: whether the durable record at `key` loses a pending→durable bind
/// collision because it is an import-owned, unprotected default label —
/// exactly a self-heal record (`session_name_policy`, the one server-side
/// meaning of "default label": the record's provider, so a provider
/// placeholder counts only for its own provider) under no folder, since
/// bind inputs carry none.
pub(super) fn import_owned_label_loses_bind(document: &StoredDocument, key: &str) -> bool {
    let Some(record) = document.record_at(key) else {
        return false;
    };
    super::session_name_policy::is_self_heal_record(record, None) && is_import_owned(document, key)
}

/// The bind decision's use of rule 2: `true` when the pending record wins
/// the collision only because the durable record is an import-owned default
/// label. Logs the decision (INFO `session_names.bind_collision_import_label_lost`)
/// when it fires; the transaction then commits the swap, and a failed commit
/// surfaces as the caller's `operation_failed` error.
pub(super) fn pending_beats_import_owned_label(
    document: &StoredDocument,
    key: &str,
    pending_source: NameSource,
) -> bool {
    let Some(current) = document.record_at(key) else {
        return false;
    };
    if !import_owned_label_loses_bind(document, key) {
        return false;
    }
    tracing::info!(
        target: "freshell_server::session_names",
        op = "bind_pending",
        name_ref = %key,
        loser_source = %wire_source(current.source),
        winner_source = %wire_source(pending_source),
        "session_names.bind_collision_import_label_lost"
    );
    true
}

/// True the first time this process sees `import_id` (until the bounded set
/// is cleared at capacity).
fn first_time_logged(import_id: &str) -> bool {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let mut logged = LOGGED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if logged.contains(import_id) {
        return false;
    }
    if logged.len() >= LOGGED_IMPORT_IDS_CAPACITY {
        logged.clear();
    }
    logged.insert(import_id.to_string());
    true
}

#[cfg(test)]
#[path = "session_name_import_policy_tests.rs"]
mod tests;
