//! A visible live/indexed session may precede its saved-name record. Only
//! that known durable target can be admitted by a rename; arbitrary ids and
//! a runtime's prospective id remain truthful missing-name responses.

use freshell_freshagent::naming::{NameError, RenameNameInput, SessionNaming};
use freshell_protocol::session_names::{SessionNameRef, SessionNameUpdate};
use freshell_sessions::directory_index::SessionIndex;
use freshell_ws::identity::TerminalIdentityRegistry;

fn known_target(
    target: &SessionNameRef,
    identity: &TerminalIdentityRegistry,
    index: Option<&SessionIndex>,
) -> bool {
    let SessionNameRef::Session {
        provider,
        session_id,
    } = target
    else {
        return false;
    };
    let live = identity.list().into_iter().any(|row| {
        row.name_ref.as_ref() == Some(target)
            && row.provider.as_deref() == Some(provider.as_str())
            && row.session_id.as_deref() == Some(session_id.as_str())
    });
    live || index.and_then(SessionIndex::peek).is_some_and(|rows| {
        rows.iter()
            .any(|row| row.provider == provider.as_str() && row.session_id == *session_id)
    })
}

pub(super) async fn rename(
    sink: &dyn SessionNaming,
    input: RenameNameInput,
    identity: &TerminalIdentityRegistry,
    index: Option<&SessionIndex>,
) -> Result<SessionNameUpdate, NameError> {
    match sink.rename(input.clone()).await {
        Err(NameError::NotFound(_)) if known_target(&input.target, identity, index) => {
            // Idempotent admission cannot replace a name committed while
            // the first rename was in flight. The original CAS and intent
            // still apply to the actual record, including a new fallback.
            sink.ensure_session(input.target.clone(), input.cwd.clone())
                .await?;
            sink.rename(input).await
        }
        result => result,
    }
}
