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
    /// Typed mode retained from the validated caller input. It is deliberately
    /// not part of the stable lookup key, but the registry revalidates it
    /// before any provider can perform I/O.
    pub mode: DurableRecoveryProvider,
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

/// Provider-owned normalization of one project-scoped query. This response
/// context is kept outside [`ExactRecoveryLookupKey`]: raw cwd spelling stays
/// stable for request addressing while the registry can still bind a
/// positive Amplifier result to the scope and cwd the provider actually
/// resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderNormalizedProject {
    pub provider_scope: String,
    pub resolved_cwd: PathBuf,
}

/// One provider result plus the normalization context used to obtain it.
///
/// A project context must be derived from the input query before artifact
/// selection. Copying scope/cwd back out of a selected proof would make the
/// registry's independent ownership check tautological.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactRecoveryProviderResult {
    pub state: ExactRecoveryState,
    pub normalized_project: Option<ProviderNormalizedProject>,
}

impl ExactRecoveryProviderResult {
    pub fn unscoped(state: ExactRecoveryState) -> Self {
        Self {
            state,
            normalized_project: None,
        }
    }

    pub fn project(
        state: ExactRecoveryState,
        provider_scope: impl Into<String>,
        resolved_cwd: PathBuf,
    ) -> Self {
        Self {
            state,
            normalized_project: Some(ProviderNormalizedProject {
                provider_scope: provider_scope.into(),
                resolved_cwd,
            }),
        }
    }
}

pub type ExactRecoverySnapshot = HashMap<ExactRecoveryLookupKey, ExactRecoveryState>;
pub type ExactRecoveryProviderSnapshot =
    HashMap<ExactRecoveryLookupKey, ExactRecoveryProviderResult>;

/// Provider adapters are synchronous because callers execute a complete batch
/// inside one admitted blocking job. Each involved provider receives at most
/// one call per registry batch.
pub trait ExactRecoveryProvider: Send + Sync {
    fn lookup_many_blocking(&self, queries: &[ExactRecoveryQuery])
        -> ExactRecoveryProviderSnapshot;
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

fn owner_matches_query(
    owner: &RecoveryOwnerKey,
    query: &ExactRecoveryQuery,
    normalized_project: Option<&ProviderNormalizedProject>,
) -> bool {
    if owner.provider != query.key.session_ref.provider
        || owner.session_id != query.key.session_ref.session_id
    {
        return false;
    }
    if !owner.has_canonical_provider_scope() {
        return false;
    }
    if query.mode != DurableRecoveryProvider::Amplifier {
        return true;
    }
    let Some(project) = normalized_project else {
        return false;
    };
    !project.provider_scope.is_empty()
        && owner.provider_scope.as_deref() == Some(project.provider_scope.as_str())
}

fn positive_result_matches_query(
    result: &ExactRecoveryProviderResult,
    query: &ExactRecoveryQuery,
) -> bool {
    let Some(owner) = positive_owner(&result.state) else {
        return true;
    };
    if !owner_matches_query(owner, query, result.normalized_project.as_ref()) {
        return false;
    }
    match (&result.state, query.mode) {
        (ExactRecoveryState::Present(proof), DurableRecoveryProvider::Amplifier) => result
            .normalized_project
            .as_ref()
            .is_some_and(|project| proof.resolved_cwd.as_ref() == Some(&project.resolved_cwd)),
        _ => true,
    }
}

/// Address an invalid direct-registry query without inventing an identity.
///
/// A mode mismatch can still name a complete, valid locator for the provider
/// carried by the session ref. Canonicalize that recognized identity so the
/// invalid query poisons an equivalent valid duplicate before provider I/O.
/// Unknown providers and invalid IDs remain under their raw keys: guessing a
/// canonical identity for malformed input could poison an unrelated lookup.
fn invalid_query_key(
    query: &ExactRecoveryQuery,
    issue: &ExactRecoveryIssue,
) -> ExactRecoveryLookupKey {
    if issue == &ExactRecoveryIssue::ProviderModeMismatch {
        if let Some(provider) = DurableRecoveryProvider::parse(&query.key.session_ref.provider) {
            if let Ok(session_ref) = validate_session_ref(provider.as_str(), &query.key.session_ref)
            {
                return ExactRecoveryLookupKey {
                    session_ref,
                    cwd: query.key.cwd.clone(),
                };
            }
        }
    }
    query.key.clone()
}

impl BlockingExactRecoveryProbe for RecoveryProviderRegistry {
    fn lookup_many_blocking(&self, queries: &[ExactRecoveryQuery]) -> ExactRecoverySnapshot {
        // Request-local normalized dedupe. Materialization advances
        // monotonically without changing the lookup identity.
        let mut normalized = Vec::<ExactRecoveryQuery>::new();
        let mut normalized_positions = HashMap::<ExactRecoveryLookupKey, usize>::new();
        let mut snapshot = ExactRecoverySnapshot::new();
        let mut invalid_keys = HashSet::<ExactRecoveryLookupKey>::new();
        for query in queries {
            let canonical = match validate_session_ref(query.mode.as_str(), &query.key.session_ref)
            {
                Ok(session_ref) => session_ref,
                Err(issue) => {
                    let key = invalid_query_key(query, &issue);
                    invalid_keys.insert(key.clone());
                    snapshot.insert(key, ExactRecoveryState::Invalid(issue));
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
                    mode: query.mode,
                    key,
                    materialization: query.materialization,
                });
            }
        }

        let mut grouped: HashMap<DurableRecoveryProvider, Vec<ExactRecoveryQuery>> = HashMap::new();
        for query in normalized {
            if invalid_keys.contains(&query.key) {
                continue;
            }
            grouped.entry(query.mode).or_default().push(query);
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
                let result = provider_snapshot.remove(&query.key).unwrap_or_else(|| {
                    ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Retryable(
                        ExactRecoveryIssue::Unproved,
                    ))
                });
                let state = if !positive_result_matches_query(&result, &query) {
                    ExactRecoveryState::Conflict
                } else {
                    result.state
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FixedStateProvider {
        result: ExactRecoveryProviderResult,
    }

    impl ExactRecoveryProvider for FixedStateProvider {
        fn lookup_many_blocking(
            &self,
            queries: &[ExactRecoveryQuery],
        ) -> ExactRecoveryProviderSnapshot {
            queries
                .iter()
                .map(|query| (query.key.clone(), self.result.clone()))
                .collect()
        }
    }

    fn query(provider: &str, session_id: &str) -> ExactRecoveryQuery {
        ExactRecoveryQuery {
            mode: DurableRecoveryProvider::parse(provider).unwrap(),
            key: ExactRecoveryLookupKey {
                session_ref: SessionLocator {
                    provider: provider.to_string(),
                    session_id: session_id.to_string(),
                },
                cwd: Some(PathBuf::from("/project")),
                store_domain: RecoveryStoreDomain::Host,
            },
            materialization: MaterializationState::Unknown,
        }
    }

    struct CountingProvider {
        calls: Arc<AtomicUsize>,
    }

    impl ExactRecoveryProvider for CountingProvider {
        fn lookup_many_blocking(
            &self,
            _queries: &[ExactRecoveryQuery],
        ) -> ExactRecoveryProviderSnapshot {
            self.calls.fetch_add(1, Ordering::SeqCst);
            ExactRecoveryProviderSnapshot::new()
        }
    }

    #[test]
    fn registry_rejects_a_direct_mode_mismatch_before_provider_io() {
        let requested = ExactRecoveryQuery {
            mode: DurableRecoveryProvider::Codex,
            key: ExactRecoveryLookupKey {
                session_ref: SessionLocator {
                    provider: "claude".to_string(),
                    session_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
                },
                cwd: Some(PathBuf::from("/project")),
                store_domain: RecoveryStoreDomain::Host,
            },
            materialization: MaterializationState::Unknown,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(CountingProvider {
                    calls: Arc::clone(&calls),
                }),
            )
            .unwrap();

        assert_eq!(
            registry
                .lookup_many_blocking(std::slice::from_ref(&requested))
                .remove(&requested.key),
            Some(ExactRecoveryState::Invalid(
                ExactRecoveryIssue::ProviderModeMismatch
            ))
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "invalid direct-registry input must never reach provider root/filesystem/SQLite I/O"
        );
    }

    #[test]
    fn registry_invalid_mode_dominates_a_same_key_valid_duplicate_in_any_order() {
        let valid = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        let mut mismatched = valid.clone();
        mismatched.mode = DurableRecoveryProvider::Codex;

        for queries in [
            vec![valid.clone(), mismatched.clone()],
            vec![mismatched.clone(), valid.clone()],
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let mut registry = RecoveryProviderRegistry::new();
            registry
                .register(
                    DurableRecoveryProvider::Claude,
                    Arc::new(CountingProvider {
                        calls: Arc::clone(&calls),
                    }),
                )
                .unwrap();

            assert_eq!(
                registry.lookup_many_blocking(&queries),
                ExactRecoverySnapshot::from([(
                    valid.key.clone(),
                    ExactRecoveryState::Invalid(ExactRecoveryIssue::ProviderModeMismatch),
                )])
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "an invalid duplicate must conservatively close the provider I/O door"
            );
        }
    }

    #[test]
    fn registry_canonicalizes_a_case_variant_mode_mismatch_before_invalid_dominance() {
        let uppercase = "550E8400-E29B-41D4-A716-446655440000";
        let canonical = "550e8400-e29b-41d4-a716-446655440000";
        let valid = query("claude", uppercase);
        let mut mismatched = valid.clone();
        mismatched.mode = DurableRecoveryProvider::Codex;
        let canonical_key = ExactRecoveryLookupKey {
            session_ref: SessionLocator {
                provider: "claude".to_string(),
                session_id: canonical.to_string(),
            },
            cwd: valid.key.cwd.clone(),
            store_domain: RecoveryStoreDomain::Host,
        };

        for queries in [
            vec![valid.clone(), mismatched.clone()],
            vec![mismatched.clone(), valid.clone()],
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let mut registry = RecoveryProviderRegistry::new();
            registry
                .register(
                    DurableRecoveryProvider::Claude,
                    Arc::new(CountingProvider {
                        calls: Arc::clone(&calls),
                    }),
                )
                .unwrap();

            assert_eq!(
                registry.lookup_many_blocking(&queries),
                ExactRecoverySnapshot::from([(
                    canonical_key.clone(),
                    ExactRecoveryState::Invalid(ExactRecoveryIssue::ProviderModeMismatch),
                )]),
                "valid and invalid case variants are one canonical poisoned identity"
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "a canonical invalid duplicate must close the provider I/O door in either order"
            );
        }
    }

    #[test]
    fn registry_does_not_let_an_unrelated_canonical_invalid_key_poison_a_valid_key() {
        let valid = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        let mut unrelated = query("claude", "6BA7B810-9DAD-11D1-80B4-00C04FD430C8");
        unrelated.mode = DurableRecoveryProvider::Codex;
        let unrelated_key = ExactRecoveryLookupKey {
            session_ref: SessionLocator {
                provider: "claude".to_string(),
                session_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8".to_string(),
            },
            cwd: unrelated.key.cwd.clone(),
            store_domain: RecoveryStoreDomain::Host,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(CountingProvider {
                    calls: Arc::clone(&calls),
                }),
            )
            .unwrap();

        assert_eq!(
            registry.lookup_many_blocking(&[unrelated, valid.clone()]),
            ExactRecoverySnapshot::from([
                (
                    unrelated_key,
                    ExactRecoveryState::Invalid(ExactRecoveryIssue::ProviderModeMismatch),
                ),
                (
                    valid.key,
                    ExactRecoveryState::Retryable(ExactRecoveryIssue::Unproved),
                ),
            ])
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "only the distinct valid identity reaches its provider"
        );
    }

    #[test]
    fn registry_keeps_uncanonicalizable_invalid_identities_raw_and_closed() {
        let unknown = ExactRecoveryQuery {
            mode: DurableRecoveryProvider::Claude,
            key: ExactRecoveryLookupKey {
                session_ref: SessionLocator {
                    provider: "future".to_string(),
                    session_id: "550E8400-E29B-41D4-A716-446655440000".to_string(),
                },
                cwd: Some(PathBuf::from("/unknown")),
                store_domain: RecoveryStoreDomain::Host,
            },
            materialization: MaterializationState::Unknown,
        };
        let invalid_uuid = ExactRecoveryQuery {
            mode: DurableRecoveryProvider::Claude,
            key: ExactRecoveryLookupKey {
                session_ref: SessionLocator {
                    provider: "claude".to_string(),
                    session_id: "not-a-uuid".to_string(),
                },
                cwd: Some(PathBuf::from("/invalid-uuid")),
                store_domain: RecoveryStoreDomain::Host,
            },
            materialization: MaterializationState::Unknown,
        };
        let traversal = ExactRecoveryQuery {
            mode: DurableRecoveryProvider::Codex,
            key: ExactRecoveryLookupKey {
                session_ref: SessionLocator {
                    provider: "amplifier".to_string(),
                    session_id: "../escaped".to_string(),
                },
                cwd: Some(PathBuf::from("/traversal")),
                store_domain: RecoveryStoreDomain::Host,
            },
            materialization: MaterializationState::Unknown,
        };
        let registry = RecoveryProviderRegistry::new();

        assert_eq!(
            registry.lookup_many_blocking(&[
                unknown.clone(),
                invalid_uuid.clone(),
                traversal.clone()
            ]),
            ExactRecoverySnapshot::from([
                (
                    unknown.key,
                    ExactRecoveryState::Invalid(ExactRecoveryIssue::UnsupportedSessionProvider),
                ),
                (
                    invalid_uuid.key,
                    ExactRecoveryState::Invalid(ExactRecoveryIssue::InvalidSessionId),
                ),
                (
                    traversal.key,
                    ExactRecoveryState::Invalid(ExactRecoveryIssue::ProviderModeMismatch),
                ),
            ]),
            "unknown or invalid identities remain raw failures instead of guessed canonical keys"
        );
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
                    result: ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Present(
                        ExactRecoveryProof {
                            owner_key: foreign,
                            artifact_fingerprint: "foreign".to_string(),
                            resolved_cwd: None,
                        },
                    )),
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
                    result: ExactRecoveryProviderResult::unscoped(
                        ExactRecoveryState::AllocatedUnmaterialized(illegally_scoped),
                    ),
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
    fn registry_rejects_an_amplifier_positive_from_a_foreign_scope() {
        let requested = query("amplifier", "shared_id");
        let context_scope = "/store/projects/a";
        let resolved_cwd = PathBuf::from("/workspace/a");
        let foreign_owner =
            RecoveryOwnerKey::project(&requested.key.session_ref, "/store/projects/b").unwrap();
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Amplifier,
                Arc::new(FixedStateProvider {
                    result: ExactRecoveryProviderResult::project(
                        ExactRecoveryState::Present(ExactRecoveryProof {
                            owner_key: foreign_owner,
                            artifact_fingerprint: "foreign-scope".to_string(),
                            resolved_cwd: Some(resolved_cwd.clone()),
                        }),
                        context_scope,
                        resolved_cwd,
                    ),
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
    fn registry_rejects_an_amplifier_allocation_from_a_foreign_scope() {
        let requested = query("amplifier", "shared_id");
        let foreign_owner =
            RecoveryOwnerKey::project(&requested.key.session_ref, "/store/projects/b").unwrap();
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Amplifier,
                Arc::new(FixedStateProvider {
                    result: ExactRecoveryProviderResult::project(
                        ExactRecoveryState::AllocatedUnmaterialized(foreign_owner),
                        "/store/projects/a",
                        PathBuf::from("/workspace/a"),
                    ),
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
    fn registry_rejects_an_amplifier_positive_with_a_foreign_resolved_cwd() {
        let requested = query("amplifier", "shared_id");
        let context_scope = "/store/projects/a";
        let owner = RecoveryOwnerKey::project(&requested.key.session_ref, context_scope).unwrap();

        for proof_cwd in [None, Some(PathBuf::from("/workspace/foreign"))] {
            let mut registry = RecoveryProviderRegistry::new();
            registry
                .register(
                    DurableRecoveryProvider::Amplifier,
                    Arc::new(FixedStateProvider {
                        result: ExactRecoveryProviderResult::project(
                            ExactRecoveryState::Present(ExactRecoveryProof {
                                owner_key: owner.clone(),
                                artifact_fingerprint: "foreign-cwd".to_string(),
                                resolved_cwd: proof_cwd,
                            }),
                            context_scope,
                            PathBuf::from("/workspace/a"),
                        ),
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

    #[test]
    fn registry_accepts_provider_normalized_amplifier_cwd_without_rekeying_raw_cwd() {
        let mut requested = query("amplifier", "shared_id");
        requested.key.cwd = Some(PathBuf::from("/workspace/link/../project"));
        let context_scope = "/store/projects/project";
        let resolved_cwd = PathBuf::from("/workspace/project");
        let proof = ExactRecoveryProof {
            owner_key: RecoveryOwnerKey::project(&requested.key.session_ref, context_scope)
                .unwrap(),
            artifact_fingerprint: "owned".to_string(),
            resolved_cwd: Some(resolved_cwd.clone()),
        };
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Amplifier,
                Arc::new(FixedStateProvider {
                    result: ExactRecoveryProviderResult::project(
                        ExactRecoveryState::Present(proof.clone()),
                        context_scope,
                        resolved_cwd,
                    ),
                }),
            )
            .unwrap();

        assert_eq!(
            registry
                .lookup_many_blocking(std::slice::from_ref(&requested))
                .remove(&requested.key),
            Some(ExactRecoveryState::Present(proof)),
            "provider normalization is response context; the stable key retains the raw cwd"
        );
    }

    #[test]
    fn registry_keeps_global_positive_cwd_behavior_unchanged() {
        let requested = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        let proof = ExactRecoveryProof {
            owner_key: RecoveryOwnerKey::global(&requested.key.session_ref).unwrap(),
            artifact_fingerprint: "owned".to_string(),
            resolved_cwd: Some(PathBuf::from("/provider/resolved")),
        };
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(FixedStateProvider {
                    result: ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Present(
                        proof.clone(),
                    )),
                }),
            )
            .unwrap();

        assert_eq!(
            registry
                .lookup_many_blocking(std::slice::from_ref(&requested))
                .remove(&requested.key),
            Some(ExactRecoveryState::Present(proof))
        );
    }

    struct CapturingProvider {
        queries: Arc<std::sync::Mutex<Vec<ExactRecoveryQuery>>>,
    }

    impl ExactRecoveryProvider for CapturingProvider {
        fn lookup_many_blocking(
            &self,
            queries: &[ExactRecoveryQuery],
        ) -> ExactRecoveryProviderSnapshot {
            self.queries.lock().unwrap().extend_from_slice(queries);
            queries
                .iter()
                .map(|query| {
                    (
                        query.key.clone(),
                        ExactRecoveryProviderResult::unscoped(
                            ExactRecoveryState::ProviderUnavailable,
                        ),
                    )
                })
                .collect()
        }
    }

    #[test]
    fn registry_dedupes_lowercase_and_uppercase_valid_queries_once() {
        let mut lowercase = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        lowercase.materialization = MaterializationState::Allocated;
        let mut uppercase = query("claude", "550E8400-E29B-41D4-A716-446655440000");
        uppercase.materialization = MaterializationState::Observed;
        let canonical_key = lowercase.key.clone();
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(CapturingProvider {
                    queries: Arc::clone(&captured),
                }),
            )
            .unwrap();

        assert_eq!(
            registry.lookup_many_blocking(&[lowercase, uppercase]),
            ExactRecoverySnapshot::from([(
                canonical_key.clone(),
                ExactRecoveryState::ProviderUnavailable,
            )])
        );
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 1, "case variants are one provider query");
        assert_eq!(captured[0].key, canonical_key);
        assert_eq!(
            captured[0].materialization,
            MaterializationState::Observed,
            "canonical dedupe keeps monotonic materialization"
        );
    }

    #[test]
    fn registry_dedupes_by_stable_key_and_advances_materialization() {
        let mut allocated = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        allocated.materialization = MaterializationState::Allocated;
        let mut observed = allocated.clone();
        observed.materialization = MaterializationState::Observed;
        assert_eq!(allocated.key, observed.key);

        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(CapturingProvider {
                    queries: Arc::clone(&captured),
                }),
            )
            .unwrap();

        let snapshot = registry.lookup_many_blocking(&[allocated.clone(), observed]);
        assert_eq!(snapshot.len(), 1);
        assert_eq!(
            snapshot.get(&allocated.key),
            Some(&ExactRecoveryState::ProviderUnavailable)
        );
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].key, allocated.key);
        assert_eq!(captured[0].materialization, MaterializationState::Observed);
    }

    #[test]
    fn registry_dispatches_identical_locators_in_distinct_store_domains() {
        let base = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        let domains = [
            RecoveryStoreDomain::Host,
            RecoveryStoreDomain::WindowsInterop,
            RecoveryStoreDomain::Wsl {
                distribution: "ubuntu".to_string(),
            },
            RecoveryStoreDomain::Wsl {
                distribution: "debian".to_string(),
            },
        ];
        let requested: Vec<_> = domains
            .iter()
            .cloned()
            .map(|store_domain| {
                let mut query = base.clone();
                query.key.store_domain = store_domain;
                query
            })
            .collect();
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(CapturingProvider {
                    queries: Arc::clone(&captured),
                }),
            )
            .unwrap();

        let snapshot = registry.lookup_many_blocking(&requested);

        assert_eq!(snapshot.len(), domains.len());
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), domains.len());
        assert_eq!(
            captured
                .iter()
                .map(|query| query.key.store_domain.clone())
                .collect::<HashSet<_>>(),
            HashSet::from(domains),
            "domain belongs to the stable pre-provider identity"
        );
    }

    #[test]
    fn registry_canonicalizes_wsl_distribution_before_dedupe() {
        let mut allocated = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        allocated.key.store_domain = RecoveryStoreDomain::Wsl {
            distribution: " Ubuntu  22.04 ".to_string(),
        };
        allocated.materialization = MaterializationState::Allocated;
        let mut observed = allocated.clone();
        observed.key.store_domain = RecoveryStoreDomain::Wsl {
            distribution: "ubuntu 22.04".to_string(),
        };
        observed.materialization = MaterializationState::Observed;
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(CapturingProvider {
                    queries: Arc::clone(&captured),
                }),
            )
            .unwrap();

        let snapshot = registry.lookup_many_blocking(&[allocated, observed]);

        assert_eq!(snapshot.len(), 1);
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(
            captured[0].key.store_domain,
            RecoveryStoreDomain::Wsl {
                distribution: "ubuntu 22.04".to_string(),
            }
        );
        assert_eq!(
            captured[0].materialization,
            MaterializationState::Observed
        );
    }

    #[test]
    fn invalid_wsl_domain_does_not_poison_an_identical_host_lookup() {
        let host = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        let mut invalid = host.clone();
        invalid.key.store_domain = RecoveryStoreDomain::Wsl {
            distribution: "..\\Ubuntu".to_string(),
        };
        let invalid_key = invalid.key.clone();
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(CapturingProvider {
                    queries: Arc::clone(&captured),
                }),
            )
            .unwrap();

        let snapshot = registry.lookup_many_blocking(&[invalid, host.clone()]);

        assert_eq!(
            snapshot.get(&invalid_key),
            Some(&ExactRecoveryState::Invalid(
                ExactRecoveryIssue::InvalidStoreDomain
            ))
        );
        assert_eq!(
            snapshot.get(&host.key),
            Some(&ExactRecoveryState::ProviderUnavailable)
        );
        assert_eq!(captured.lock().unwrap().as_slice(), &[host]);
    }

    #[test]
    fn materialization_advances_monotonically_within_each_domain_only() {
        let mut host_allocated = query("claude", "550e8400-e29b-41d4-a716-446655440000");
        host_allocated.materialization = MaterializationState::Allocated;
        let mut host_observed = host_allocated.clone();
        host_observed.materialization = MaterializationState::Observed;
        let mut windows_allocated = host_allocated.clone();
        windows_allocated.key.store_domain = RecoveryStoreDomain::WindowsInterop;
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut registry = RecoveryProviderRegistry::new();
        registry
            .register(
                DurableRecoveryProvider::Claude,
                Arc::new(CapturingProvider {
                    queries: Arc::clone(&captured),
                }),
            )
            .unwrap();

        let snapshot =
            registry.lookup_many_blocking(&[host_allocated, windows_allocated, host_observed]);

        assert_eq!(snapshot.len(), 2);
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 2);
        assert_eq!(
            captured
                .iter()
                .map(|query| (&query.key.store_domain, query.materialization))
                .collect::<HashMap<_, _>>(),
            HashMap::from([
                (&RecoveryStoreDomain::Host, MaterializationState::Observed),
                (
                    &RecoveryStoreDomain::WindowsInterop,
                    MaterializationState::Allocated,
                ),
            ])
        );
    }
}
