//! A pane's prospective session can still name through its unspent pending
//! handle. After a conversation switch a spent handle must never retarget
//! the rename to the old conversation: admit the new known session instead.

use crate::naming::{NameError, RenameNameInput, SessionNaming};
use crate::FreshAgentState;
use freshell_protocol::session_names::{SessionNameRef, SessionNameUpdate};

pub(crate) fn terminal_binding(
    state: &FreshAgentState,
    content: &serde_json::Value,
) -> Option<SessionNameRef> {
    if content.get("kind").and_then(serde_json::Value::as_str) != Some("terminal") {
        return None;
    }
    let terminal_id = content.get("terminalId")?.as_str()?;
    state.terminal_registry.as_ref()?.name_ref_of(terminal_id)
}

/// Materialization changes a pending ref to its own session between editor
/// capture and submit. That verified redirect keeps the same target. A
/// redirect to an earlier conversation never makes a switched capture valid.
pub(crate) async fn capture_matches(
    state: &FreshAgentState,
    expected: Option<&SessionNameRef>,
    target: &SessionNameRef,
) -> Result<bool, NameError> {
    if expected == Some(target) {
        return Ok(true);
    }
    let Some(expected @ SessionNameRef::Pending { .. }) = expected else {
        return Ok(false);
    };
    if !matches!(target, SessionNameRef::Session { .. }) {
        return Ok(false);
    }
    let sink = state
        .naming()
        .ok_or_else(|| crate::naming::naming_unavailable("rename capture resolution"))?;
    let updates = sink.get(vec![expected.clone()]).await?;
    Ok(updates.into_iter().any(|update| {
        &update.record.name_ref == target
            && update
                .redirects
                .iter()
                .any(|redirect| &redirect.from == expected && &redirect.to == target)
    }))
}

pub(crate) async fn rename(
    state: &FreshAgentState,
    sink: &dyn SessionNaming,
    pane_id: Option<&str>,
    input: RenameNameInput,
) -> Result<SessionNameUpdate, NameError> {
    let error = match sink.rename(input.clone()).await {
        Ok(update) => return Ok(update),
        Err(error) => error,
    };
    if !matches!(error, NameError::NotFound(_))
        || !matches!(input.target, SessionNameRef::Session { .. })
    {
        return Err(error);
    }

    if let Some(pending) = pane_id.and_then(|id| crate::resolve_pane_pending_binding(state, id)) {
        let updates = sink.get(vec![pending.clone()]).await?;
        if let Some(update) = updates.into_iter().find(|update| {
            update.record.name_ref == pending || update.record.name_ref == input.target
        }) {
            // The pending handle may bind while this request is in flight.
            // Pin the observed revision so that redirect cannot silently
            // send this rename to a different conversation after the read.
            let revision = input.if_revision.or(Some(update.record.revision));
            return sink
                .rename(RenameNameInput {
                    target: pending,
                    if_revision: revision,
                    ..input
                })
                .await;
        }
    }
    // There is no applicable pending name. The layout/identity already
    // resolved this pane to the durable target; its index row can arrive
    // later. Admission never replaces an existing (possibly protected) name.
    sink.ensure_session(input.target.clone(), input.cwd.clone())
        .await?;
    sink.rename(input).await
}
