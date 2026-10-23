//! Undo/redo replaces a runtime while continuing the same conversation.
//! Its child inherits the current saved name once; explicit fork-to-new
//! and ordinary conversation switches never call this operation.

use super::*;
use crate::naming::NameError;
use freshell_protocol::session_names::{NamedProvider, SessionNameRef};

impl FreshClaudeState {
    pub(super) async fn preserve_rollback_name(
        &self,
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
        // Establishment binds creates to their native UUID. A prior undo
        // may have independently renamed this child, so copy this current
        // durable record, never an ancestor's pending handle.
        let source = durable;
        let target = SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: replacement.into(),
        };
        sink.continue_session(source, target.clone())
            .await
            .map_err(|error| {
                crate::naming::log_name_error("internal_continuation", &target, &error);
                error
            })?;
        Ok(())
    }
}
