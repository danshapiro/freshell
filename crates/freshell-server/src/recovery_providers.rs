// These explicit adapters intentionally remain dormant until the aggregate
// exact-recovery runtime is composed. Keeping the construction boundary in
// production code now prevents later provider work from reaching through
// HOME, History, or another provider's store.
#![allow(dead_code, reason = "exact recovery runtime is intentionally dormant")]

use std::path::PathBuf;
use std::sync::Arc;

use freshell_recovery::{
    DurableRecoveryProvider, ExactRecoveryProvider, ExactRecoveryQuery, ExactRecoverySnapshot,
    ExactRecoveryState, RecoveryProviderRegistry, RegistryRegistrationError,
};

/// Explicit provider-store locations. Missing entries stay unregistered; this
/// constructor never falls back through `HOME`, `provider_home()`, or the
/// History `SessionIndex`.
#[derive(Default)]
pub(crate) struct RecoveryProviderOverrides {
    pub claude_root: Option<Arc<dyn RecoveryPathResolver>>,
    pub codex_sessions_root: Option<Arc<dyn RecoveryPathResolver>>,
    pub opencode_database: Option<PathBuf>,
    pub amplifier_root: Option<Arc<dyn RecoveryPathResolver>>,
}

/// Mutable provider roots are resolved inside every admitted registry batch.
/// Implementations may read config/environment, but construction never does.
pub(crate) trait RecoveryPathResolver: Send + Sync {
    fn resolve(&self) -> std::io::Result<PathBuf>;
}

#[derive(Debug, Clone)]
enum ProviderStoreLocation {
    Directory(PathBuf),
    Database(PathBuf),
}

enum ProviderStoreSource {
    MutableDirectory(Arc<dyn RecoveryPathResolver>),
    ImmutableDatabase(PathBuf),
}

impl ProviderStoreSource {
    fn resolve(&self) -> std::io::Result<ProviderStoreLocation> {
        match self {
            Self::MutableDirectory(resolver) => {
                resolver.resolve().map(ProviderStoreLocation::Directory)
            }
            Self::ImmutableDatabase(path) => Ok(ProviderStoreLocation::Database(path.clone())),
        }
    }
}

struct ConfiguredRecoveryProvider {
    source: ProviderStoreSource,
}

impl ExactRecoveryProvider for ConfiguredRecoveryProvider {
    fn lookup_many_blocking(&self, queries: &[ExactRecoveryQuery]) -> ExactRecoverySnapshot {
        let _resolved_location = match self.source.resolve() {
            Ok(location) => location,
            Err(_) => {
                return queries
                    .iter()
                    .map(|query| {
                        (
                            query.key.clone(),
                            ExactRecoveryState::Retryable(
                                freshell_recovery::ExactRecoveryIssue::StoreReadFailed,
                            ),
                        )
                    })
                    .collect();
            }
        };
        // Task 1 closes and wires the boundary while keeping the exact runtime
        // dormant. Provider readers replace this unavailable adapter in the
        // provider task before the aggregate runtime can be constructed.
        queries
            .iter()
            .map(|query| (query.key.clone(), ExactRecoveryState::ProviderUnavailable))
            .collect()
    }
}

pub(crate) fn build_recovery_provider_registry(
    overrides: RecoveryProviderOverrides,
) -> Result<RecoveryProviderRegistry, RegistryRegistrationError> {
    let mut registry = RecoveryProviderRegistry::new();
    let configured = [
        (
            DurableRecoveryProvider::Claude,
            overrides
                .claude_root
                .map(ProviderStoreSource::MutableDirectory),
        ),
        (
            DurableRecoveryProvider::Codex,
            overrides
                .codex_sessions_root
                .map(ProviderStoreSource::MutableDirectory),
        ),
        (
            DurableRecoveryProvider::Opencode,
            overrides
                .opencode_database
                .map(ProviderStoreSource::ImmutableDatabase),
        ),
        (
            DurableRecoveryProvider::Amplifier,
            overrides
                .amplifier_root
                .map(ProviderStoreSource::MutableDirectory),
        ),
    ];
    for (provider, location) in configured {
        if let Some(location) = location {
            registry.register(
                provider,
                Arc::new(ConfiguredRecoveryProvider { source: location }),
            )?;
        }
    }
    Ok(registry)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use freshell_protocol::SessionLocator;
    use freshell_recovery::{
        BlockingExactRecoveryProbe, DurableRecoveryProvider, ExactRecoveryLookupKey,
        ExactRecoveryQuery, ExactRecoveryState, MaterializationState,
    };

    use super::{
        build_recovery_provider_registry, RecoveryPathResolver, RecoveryProviderOverrides,
    };

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct HomeGuard(Option<std::ffi::OsString>);

    impl HomeGuard {
        fn remove() -> Self {
            let previous = std::env::var_os("HOME");
            std::env::remove_var("HOME");
            Self(previous)
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            if let Some(value) = self.0.take() {
                std::env::set_var("HOME", value);
            } else {
                std::env::remove_var("HOME");
            }
        }
    }

    #[derive(Debug)]
    struct FixedResolver(PathBuf);

    impl RecoveryPathResolver for FixedResolver {
        fn resolve(&self) -> std::io::Result<PathBuf> {
            Ok(self.0.clone())
        }
    }

    fn fixed(path: &str) -> Arc<dyn RecoveryPathResolver> {
        Arc::new(FixedResolver(PathBuf::from(path)))
    }

    #[test]
    fn recovery_providers_construct_independently_without_home() {
        let _env = ENV_LOCK.lock().unwrap();
        let _home = HomeGuard::remove();
        let cases = [
            (
                RecoveryProviderOverrides {
                    claude_root: Some(fixed("/isolated/claude")),
                    ..Default::default()
                },
                DurableRecoveryProvider::Claude,
            ),
            (
                RecoveryProviderOverrides {
                    codex_sessions_root: Some(fixed("/isolated/codex/sessions")),
                    ..Default::default()
                },
                DurableRecoveryProvider::Codex,
            ),
            (
                RecoveryProviderOverrides {
                    opencode_database: Some(PathBuf::from("/isolated/opencode/opencode.db")),
                    ..Default::default()
                },
                DurableRecoveryProvider::Opencode,
            ),
            (
                RecoveryProviderOverrides {
                    amplifier_root: Some(fixed("/isolated/amplifier")),
                    ..Default::default()
                },
                DurableRecoveryProvider::Amplifier,
            ),
        ];

        for (overrides, expected) in cases {
            let registry =
                build_recovery_provider_registry(overrides).expect("explicit root is sufficient");
            assert_eq!(registry.registered_providers(), vec![expected]);
        }
    }

    #[derive(Debug)]
    struct MutableResolver {
        current: Mutex<PathBuf>,
        resolutions: Mutex<Vec<PathBuf>>,
    }

    impl MutableResolver {
        fn new(path: &str) -> Self {
            Self {
                current: Mutex::new(PathBuf::from(path)),
                resolutions: Mutex::new(Vec::new()),
            }
        }

        fn set(&self, path: &str) {
            *self.current.lock().unwrap() = PathBuf::from(path);
        }
    }

    impl RecoveryPathResolver for MutableResolver {
        fn resolve(&self) -> std::io::Result<PathBuf> {
            let path = self.current.lock().unwrap().clone();
            self.resolutions.lock().unwrap().push(path.clone());
            Ok(path)
        }
    }

    #[test]
    fn mutable_provider_root_is_reresolved_for_every_registry_batch() {
        let resolver = Arc::new(MutableResolver::new("/first/claude"));
        let registry = build_recovery_provider_registry(RecoveryProviderOverrides {
            claude_root: Some(resolver.clone()),
            ..Default::default()
        })
        .unwrap();
        let query = ExactRecoveryQuery {
            key: ExactRecoveryLookupKey {
                session_ref: SessionLocator {
                    provider: "claude".to_string(),
                    session_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
                },
                cwd: None,
            },
            materialization: MaterializationState::Unknown,
        };

        let first = registry.lookup_many_blocking(std::slice::from_ref(&query));
        resolver.set("/second/claude");
        let second = registry.lookup_many_blocking(std::slice::from_ref(&query));

        assert_eq!(
            first.get(&query.key),
            Some(&ExactRecoveryState::ProviderUnavailable)
        );
        assert_eq!(
            second.get(&query.key),
            Some(&ExactRecoveryState::ProviderUnavailable)
        );
        assert_eq!(
            *resolver.resolutions.lock().unwrap(),
            vec![
                PathBuf::from("/first/claude"),
                PathBuf::from("/second/claude")
            ],
            "the adapter must not cache a mutable provider root between batches"
        );
    }
}
