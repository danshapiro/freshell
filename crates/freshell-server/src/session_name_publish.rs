//! Subscriber publication for a transaction that also adopts a newer
//! same-home document. The whole committed delta belongs to this store's
//! subscribers, even when the transaction itself changed a different name.

use std::collections::BTreeMap;

use freshell_protocol::session_names::SessionNameUpdate;

use super::{delta_updates, materialize_publish, name_ref_key, PublishSpec, StoredDocument};

/// One final frame per naming ref, from the last published view to the
/// committed document. Decision-owned frames also carry status-only or
/// redirect changes that do not alter a name revision. Merging by ref keeps
/// those frames while avoiding an intermediate or duplicate name when this
/// transaction changes a record it just adopted.
pub(super) fn committed_updates(
    prior: &StoredDocument,
    committed: &StoredDocument,
    own: &[PublishSpec],
) -> Vec<SessionNameUpdate> {
    let mut updates = BTreeMap::<String, SessionNameUpdate>::new();
    for update in delta_updates(prior, committed)
        .into_iter()
        .chain(materialize_publish(committed, own))
    {
        updates
            .entry(name_ref_key(&update.record.name_ref))
            .and_modify(|current| current.changed |= update.changed)
            .or_insert(update);
    }
    updates.into_values().collect()
}

#[cfg(test)]
#[path = "session_name_publish_adoption_tests.rs"]
mod tests;
