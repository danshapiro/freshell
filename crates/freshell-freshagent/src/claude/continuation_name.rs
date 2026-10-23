//! Undo/redo replaces a runtime while continuing the same conversation.
//! Its child inherits the current saved name once; explicit fork-to-new
//! and ordinary conversation switches never call this operation.

use super::*;
use crate::naming::NameError;
use freshell_protocol::session_names::{NamedProvider, SessionNameRef};

impl FreshClaudeState {
    pub(super) async fn preserve_rollback_name(
        &self,
        original_key: &str,
        original_session: &str,
        replacement: &str,
        session_type: &str,
    ) -> Result<(), NameError> {
        if session_type == "kilroy" {
            return Ok(());
        }
        let Some(sink) = self.naming() else {
            return Ok(());
        };
        let durable = SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: original_session.into(),
        };
        // A prior undo may itself have an independently renamed child.
        // Prefer this current session, never its ancestor's spent handle.
        let source = if sink
            .get(vec![durable.clone()])
            .await
            .inspect_err(|error| {
                crate::naming::log_name_error("internal_continuation_read", &durable, error);
            })?
            .is_empty()
        {
            self.naming_handles
                .lock()
                .await
                .get(original_key)
                .cloned()
                .map(|id| SessionNameRef::Pending { id })
                .unwrap_or(durable)
        } else {
            durable
        };
        let target = SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: replacement.into(),
        };
        sink.continue_session(source, target.clone())
            .await
            .inspect_err(|error| {
                crate::naming::log_name_error("internal_continuation", &target, error);
            })?;
        Ok(())
    }
}
