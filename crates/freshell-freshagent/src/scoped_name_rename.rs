//! A pane's prospective session can still name through its unspent pending
//! handle. After a conversation switch a spent handle must never retarget
//! the rename to the old conversation: admit the new known session instead.

use crate::naming::{
    is_unified_agent_mode, named_provider_for, NameError, RenameNameInput, SessionNaming,
};
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

struct LegacyPrebind {
    prospective: SessionNameRef,
    pending: SessionNameRef,
}

fn legacy_prebind(state: &FreshAgentState, pane_id: &str) -> Option<LegacyPrebind> {
    let snapshot = state.layout.get_pane_snapshot(pane_id)?;
    let content = snapshot.pane_content.as_ref()?;
    if !is_unified_agent_mode(
        content.get("mode").and_then(serde_json::Value::as_str),
        None,
    ) || content.get("nameRef").is_some_and(|value| !value.is_null())
        || content
            .get("namingHandle")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|handle| !handle.trim().is_empty())
    {
        return None;
    }
    let pending = terminal_binding(state, content)?;
    if !matches!(pending, SessionNameRef::Pending { .. }) {
        return None;
    }
    let locator: freshell_protocol::SessionLocator =
        serde_json::from_value(content.get("sessionRef")?.clone()).ok()?;
    if locator.session_id.trim().is_empty() {
        return None;
    }
    let provider = named_provider_for(Some(&locator.provider), None)?;
    Some(LegacyPrebind {
        prospective: SessionNameRef::Session {
            provider,
            session_id: locator.session_id,
        },
        pending,
    })
}

/// Older editors know only the prospective sessionRef. Keep their original
/// session-first/pending-fallback path. A modern pending capture still uses
/// the authoritative registry, even when its layout replica lacks the fields.
pub(crate) fn legacy_prebind_target(
    state: &FreshAgentState,
    pane_id: &str,
    capture: Option<&SessionNameRef>,
) -> Option<SessionNameRef> {
    let legacy = legacy_prebind(state, pane_id)?;
    capture
        .is_none_or(|target| target == &legacy.prospective)
        .then_some(legacy.prospective)
}

/// A bare sessionRef may be a preallocated runtime id rather than an
/// established naming target. Only an explicit durable naming ref or the
/// current durable registry binding authorizes creating its missing name.
fn may_admit_session(
    state: &FreshAgentState,
    pane_id: Option<&str>,
    target: &SessionNameRef,
) -> bool {
    let Some(snapshot) = pane_id.and_then(|id| state.layout.get_pane_snapshot(id)) else {
        return false;
    };
    let Some(content) = snapshot.pane_content.as_ref() else {
        return false;
    };
    terminal_binding(state, content).as_ref() == Some(target)
        || content
            .get("nameRef")
            .and_then(|raw| serde_json::from_value::<SessionNameRef>(raw.clone()).ok())
            .as_ref()
            == Some(target)
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
    if let Some(legacy) = pane_id
        .and_then(|id| legacy_prebind(state, id))
        .filter(|legacy| legacy.prospective == input.target)
    {
        let updates = sink.get(vec![legacy.pending.clone()]).await?;
        if updates.iter().any(|update| {
            update.record.name_ref != legacy.pending && update.record.name_ref != input.target
        }) {
            return Err(NameError::NotFound(
                "the pre-bind naming handle belongs to a different conversation".into(),
            ));
        }
    }
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
    // With no applicable pending name, a genuinely established target may
    // precede its index row. A bare prospective id still returns 404.
    if !may_admit_session(state, pane_id, &input.target) {
        return Err(error);
    }
    // Admission never replaces an existing (possibly protected) name.
    sink.ensure_session(input.target.clone(), input.cwd.clone())
        .await?;
    sink.rename(input).await
}
