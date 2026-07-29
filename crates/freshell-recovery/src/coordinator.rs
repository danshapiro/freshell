use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use freshell_protocol::SessionLocator;

use crate::{
    validate_session_ref, DurableRecoveryProvider, ExactRecoveryIssue, ExactRecoveryProof,
    MaterializationState, RecoveryOwnerKey,
};

/// Stable provider/session/cwd identity for one exact lookup.
///
/// Materialization deliberately does not participate in equality or hashing:
/// an Allocated→Observed transition remains addressable in the same request.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExactRecoveryLookupKey {
    pub session_ref: SessionLocator,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactRecoveryQuery {
    pub key: ExactRecoveryLookupKey,
    pub materialization: MaterializationState,
}

/// Exact recovery is positive-only. No miss, stale read, or provider failure
/// can become an authoritative absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExactRecoveryState {
    Present(ExactRecoveryProof),
    AllocatedUnmaterialized(RecoveryOwnerKey),
    Retryable(ExactRecoveryIssue),
    ProviderUnavailable,
    Conflict,
    Invalid(ExactRecoveryIssue),
}

pub type ExactRecoverySnapshot = HashMap<ExactRecoveryLookupKey, ExactRecoveryState>;

/// Provider adapters are synchronous because callers execute a complete batch
/// inside one admitted blocking job. Each involved provider receives at most
/// one call per registry batch.
pub trait ExactRecoveryProvider: Send + Sync {
    fn lookup_many_blocking(&self, queries: &[ExactRecoveryQuery]) -> ExactRecoverySnapshot;
}

/// The only store-I/O route exposed to the future async coordinator.
pub trait BlockingExactRecoveryProbe: Send + Sync {
    fn lookup_many_blocking(&self, queries: &[ExactRecoveryQuery]) -> ExactRecoverySnapshot;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryRegistrationError {
    pub provider: DurableRecoveryProvider,
}

/// Closed, typed dispatch from canonical durable locators to provider stores.
#[derive(Default)]
pub struct RecoveryProviderRegistry {
    providers: HashMap<DurableRecoveryProvider, Arc<dyn ExactRecoveryProvider>>,
}

impl RecoveryProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &mut self,
        provider: DurableRecoveryProvider,
        implementation: Arc<dyn ExactRecoveryProvider>,
    ) -> Result<(), RegistryRegistrationError> {
        match self.providers.entry(provider) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(implementation);
                Ok(())
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                Err(RegistryRegistrationError { provider })
            }
        }
    }

    pub fn registered_providers(&self) -> Vec<DurableRecoveryProvider> {
        DurableRecoveryProvider::ALL
            .into_iter()
            .filter(|provider| self.providers.contains_key(provider))
            .collect()
    }
}

fn positive_owner(state: &ExactRecoveryState) -> Option<&RecoveryOwnerKey> {
    match state {
        ExactRecoveryState::Present(proof) => Some(&proof.owner_key),
        ExactRecoveryState::AllocatedUnmaterialized(owner) => Some(owner),
        _ => None,
    }
}

fn owner_matches_query(owner: &RecoveryOwnerKey, query: &ExactRecoveryLookupKey) -> bool {
    if owner.provider != query.session_ref.provider
        || owner.session_id != query.session_ref.session_id
    {
        return false;
    }
    owner.has_canonical_provider_scope()
}

impl BlockingExactRecoveryProbe for RecoveryProviderRegistry {
    fn lookup_many_blocking(&self, queries: &[ExactRecoveryQuery]) -> ExactRecoverySnapshot {
        // Request-local normalized dedupe. Materialization advances
        // monotonically without changing the lookup identity.
        let mut normalized = Vec::<ExactRecoveryQuery>::new();
        let mut normalized_positions = HashMap::<ExactRecoveryLookupKey, usize>::new();
        let mut snapshot = ExactRecoverySnapshot::new();
        for query in queries {
            let canonical =
                match validate_session_ref(&query.key.session_ref.provider, &query.key.session_ref)
                {
                    Ok(session_ref) => session_ref,
                    Err(issue) => {
                        snapshot.insert(query.key.clone(), ExactRecoveryState::Invalid(issue));
                        continue;
                    }
                };
            let key = ExactRecoveryLookupKey {
                session_ref: canonical,
                cwd: query.key.cwd.clone(),
            };
            if let Some(&position) = normalized_positions.get(&key) {
                let current = &mut normalized[position];
                current.materialization = current.materialization.advance(query.materialization);
            } else {
                normalized_positions.insert(key.clone(), normalized.len());
                normalized.push(ExactRecoveryQuery {
                    key,
                    materialization: query.materialization,
                });
            }
        }

        let mut grouped: HashMap<DurableRecoveryProvider, Vec<ExactRecoveryQuery>> = HashMap::new();
        for query in normalized {
            let Some(provider) = DurableRecoveryProvider::parse(&query.key.session_ref.provider)
            else {
                snapshot.insert(
                    query.key,
                    ExactRecoveryState::Invalid(ExactRecoveryIssue::UnsupportedSessionProvider),
                );
                continue;
            };
            grouped.entry(provider).or_default().push(query);
        }

        for provider_kind in DurableRecoveryProvider::ALL {
            let Some(provider_queries) = grouped.remove(&provider_kind) else {
                continue;
            };
            let Some(provider) = self.providers.get(&provider_kind) else {
                snapshot.extend(
                    provider_queries
                        .into_iter()
                        .map(|query| (query.key, ExactRecoveryState::ProviderUnavailable)),
                );
                continue;
            };

            let requested: HashSet<_> = provider_queries
                .iter()
                .map(|query| query.key.clone())
                .collect();
            let mut provider_snapshot = provider.lookup_many_blocking(&provider_queries);
            provider_snapshot.retain(|key, _| requested.contains(key));
            for query in provider_queries {
                let state = provider_snapshot
                    .remove(&query.key)
                    .unwrap_or(ExactRecoveryState::Retryable(ExactRecoveryIssue::Unproved));
                let state = if positive_owner(&state)
                    .is_some_and(|owner| !owner_matches_query(owner, &query.key))
                {
                    ExactRecoveryState::Conflict
                } else {
                    state
                };
                snapshot.insert(query.key, state);
            }
        }
        snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedStateProvider {
        state: ExactRecoveryState,
    }

    impl ExactRecoveryProvider for FixedStateProvider {
        fn lookup_many_blocking(&self, queries: &[ExactRecoveryQuery]) -> ExactRecoverySnapshot {
            queries
                .iter()
                .map(|query| (query.key.clone(), self.state.clone()))
                .collect()
        }
    }

    fn query(provider: &str, session_id: &str) -> ExactRecoveryQuery {
        ExactRecoveryQuery {
            key: ExactRecoveryLookupKey {
                session_ref: SessionLocator {
                    provider: provider.to_string(),
                    session_id: session_id.to_string(),
                },
                cwd: Some(PathBuf::from("/project")),
            },
            materialization: MaterializationState::Unknown,
        }
    }

    #[test]
    fn registry_rejects_positive_state_for_a_foreign_owner() {
        let requested = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        let foreign = RecoveryOwnerKey {
            provider: "claude".to_string(),
            session_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8".to_string(),
            provider_scope: None,
        };
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(FixedStateProvider {
                    state: ExactRecoveryState::Present(ExactRecoveryProof {
                        owner_key: foreign,
                        artifact_fingerprint: "foreign".to_string(),
                        resolved_cwd: None,
                    }),
                }),
            )
            .unwrap();

        assert_eq!(
            registry
                .lookup_many_blocking(std::slice::from_ref(&requested))
                .remove(&requested.key),
            Some(ExactRecoveryState::Conflict)
        );
    }

    #[test]
    fn registry_rejects_illegal_scope_in_a_global_positive_state() {
        let requested = query("codex", "01890f47-9f6a-7b2c-8d3e-4f5061728394");
        let illegally_scoped = RecoveryOwnerKey {
            provider: "codex".to_string(),
            session_id: requested.key.session_ref.session_id.clone(),
            provider_scope: Some("/foreign/scope".to_string()),
        };
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Codex,
                Arc::new(FixedStateProvider {
                    state: ExactRecoveryState::AllocatedUnmaterialized(illegally_scoped),
                }),
            )
            .unwrap();

        assert_eq!(
            registry
                .lookup_many_blocking(std::slice::from_ref(&requested))
                .remove(&requested.key),
            Some(ExactRecoveryState::Conflict)
        );
    }
}
