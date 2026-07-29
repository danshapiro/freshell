use freshell_protocol::SessionLocator;
use serde::{Deserialize, Serialize};

use crate::{DurableRecoveryProvider, ExactRecoveryIssue};

/// Cross-kind durable owner. Global providers have no scope; Amplifier stores
/// the provider-resolved normalized project scope.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOwnerKey {
    pub provider: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_scope: Option<String>,
}

impl RecoveryOwnerKey {
    /// Whether the owner carries the provider-defined canonical scope shape.
    ///
    /// Session-id validation happens before owner construction. This guard is
    /// deliberately narrower: global providers must remain unscoped, while
    /// Amplifier authority always names one non-empty normalized store scope.
    pub fn has_canonical_provider_scope(&self) -> bool {
        match DurableRecoveryProvider::parse(&self.provider) {
            Some(DurableRecoveryProvider::Amplifier) => self
                .provider_scope
                .as_deref()
                .is_some_and(|scope| !scope.is_empty()),
            Some(_) => self.provider_scope.is_none(),
            None => false,
        }
    }

    pub fn global(session: &SessionLocator) -> Result<Self, ExactRecoveryIssue> {
        let provider = DurableRecoveryProvider::parse(&session.provider)
            .ok_or(ExactRecoveryIssue::UnsupportedSessionProvider)?;
        if provider == DurableRecoveryProvider::Amplifier {
            return Err(ExactRecoveryIssue::MissingProjectScope);
        }
        Ok(Self {
            provider: provider.as_str().to_string(),
            session_id: session.session_id.clone(),
            provider_scope: None,
        })
    }

    /// Build an Amplifier owner only after its provider has normalized the
    /// effective project-store scope for the raw lookup cwd.
    pub fn project(
        session: &SessionLocator,
        normalized_provider_scope: &str,
    ) -> Result<Self, ExactRecoveryIssue> {
        if DurableRecoveryProvider::parse(&session.provider)
            != Some(DurableRecoveryProvider::Amplifier)
            || normalized_provider_scope.is_empty()
        {
            return Err(ExactRecoveryIssue::MissingProjectScope);
        }
        Ok(Self {
            provider: DurableRecoveryProvider::Amplifier.as_str().to_string(),
            session_id: session.session_id.clone(),
            provider_scope: Some(normalized_provider_scope.to_string()),
        })
    }
}
