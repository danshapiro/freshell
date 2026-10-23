//! Fill uncached terminal names in one read, retry missing pending records,
//! and reject handles that moved to an earlier conversation. The tick and
//! create bind share the same record/redirect matching rule.

use freshell_protocol::session_names::{
    NamedProvider, SessionNameRecord, SessionNameRef, SessionNameUpdate,
};
use freshell_terminal::TerminalRegistry;

use super::{
    apply_binding, keep_record_less_target, log_superseded, still_bound, NameBinding,
    TerminalNameBinder,
};
use crate::naming::{log_name_error, PendingNameInput, SessionNaming};

/// A bound row whose display cache is empty.
pub(super) struct UncachedRow {
    pub(super) terminal_id: String,
    pub(super) provider: NamedProvider,
    pub(super) cwd: Option<String>,
    pub(super) name_ref: SessionNameRef,
    pub(super) durable_target: Option<SessionNameRef>,
    pub(super) fallback_title: String,
}

/// What one cache-fill pass found.
#[derive(Default)]
pub(super) struct FillReport {
    pub(super) filled: usize,
    /// Rows still bound to a durable session that answered "no record".
    pub(super) empty: Vec<(String, SessionNameRef)>,
}

/// Fill every uncached bound row from ONE batched read; a pending binding
/// whose record was never admitted (its create's `ensure_pending` failed)
/// is admitted here, once per tick. An answer for a row whose binding moved
/// during the read is dropped.
pub(super) async fn fill_uncached_rows(
    sink: &dyn SessionNaming,
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    uncached: &[UncachedRow],
) -> FillReport {
    let mut report = FillReport::default();
    if uncached.is_empty() {
        return report;
    }
    let mut refs: Vec<SessionNameRef> = Vec::new();
    for row in uncached {
        if !refs.contains(&row.name_ref) {
            refs.push(row.name_ref.clone());
        }
    }
    let updates = match sink.get(refs).await {
        Ok(updates) => updates,
        Err(error) => {
            tracing::warn!(
                target: "freshell_freshagent::naming",
                op = "get",
                rows = uncached.len(),
                class = %error.code(),
                "session_names.terminal_cache_fill_deferred: {error}"
            );
            return report;
        }
    };
    for row in uncached {
        if !still_bound(registry, &row.terminal_id, &row.name_ref) {
            log_superseded(&row.terminal_id, &row.name_ref);
            continue;
        }
        if let Some(update) = updates.iter().find(|update| answers(update, &row.name_ref)) {
            if accept_answer(registry, binder, row, &update.record) {
                report.filled += 1;
            }
            continue;
        }
        let SessionNameRef::Pending { id } = &row.name_ref else {
            // A durable session with no record yet: nothing to fill; the
            // publisher fills the row when the session is named.
            report
                .empty
                .push((row.terminal_id.clone(), row.name_ref.clone()));
            continue;
        };
        let admitted = sink
            .ensure_pending(PendingNameInput {
                handle: id.clone(),
                provider: row.provider,
                cwd: row.cwd.clone(),
            })
            .await;
        match admitted {
            Ok(_) if !still_bound(registry, &row.terminal_id, &row.name_ref) => {
                log_superseded(&row.terminal_id, &row.name_ref);
            }
            Ok(update) => {
                if accept_answer(registry, binder, row, &update.record) {
                    report.filled += 1;
                }
            }
            Err(error) => log_name_error("ensure_pending", &row.name_ref, &error),
        }
    }
    report
}

/// Whether `update` answers a read of `name_ref` (directly, or through the
/// pending→durable redirect the store traversed).
pub(super) fn answers(update: &SessionNameUpdate, name_ref: &SessionNameRef) -> bool {
    &update.record.name_ref == name_ref
        || update
            .redirects
            .iter()
            .any(|redirect| &redirect.from == name_ref)
}

fn accept_answer(
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
