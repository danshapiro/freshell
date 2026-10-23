//! The cache-fill retry must enforce the same spent-handle rule as the
//! create bind: recovering from an unavailable store cannot attach a name
//! the handle transferred to an earlier conversation.

use super::*;

pub(super) fn accept_answer(
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    row: &UncachedRow,
    record: &SessionNameRecord,
) -> bool {
    if matches!(row.name_ref, SessionNameRef::Pending { .. }) {
        if let Some(target) = row
            .durable_target
            .as_ref()
            .filter(|target| record.name_ref != row.name_ref && &record.name_ref != *target)
        {
            apply_binding(
                registry,
                binder,
                &row.terminal_id,
                &NameBinding {
                    name_ref: target.clone(),
                    naming_handle: None,
                },
            );
            keep_record_less_target(
                registry,
                &row.terminal_id,
                target,
                &row.name_ref,
                &record.name_ref,
                &row.fallback_title,
            );
            return false;
        }
    }
    registry.update_session_name(&row.terminal_id, record);
    true
}
