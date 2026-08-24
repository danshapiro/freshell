// These explicit adapters intentionally remain dormant until the aggregate
// exact-recovery runtime is composed. Keeping the construction boundary in
// production code now prevents later provider work from reaching through
// HOME, History, or another provider's store.
#![allow(dead_code, reason = "exact recovery runtime is intentionally dormant")]

use std::path::PathBuf;
use std::sync::Arc;

use freshell_recovery::{
    DurableRecoveryProvider, ExactRecoveryProvider, ExactRecoveryProviderResult,
    ExactRecoveryProviderSnapshot, ExactRecoveryQuery, ExactRecoveryState,
    RecoveryProviderRegistry, RegistryRegistrationError,
};

/// Explicit provider-store locations. Missing entries stay unregistered; this
/// constructor never falls back through `HOME`, `provider_home()`, or the
/// History `SessionIndex`.
#[derive(Default)]
pub(crate) struct RecoveryProviderOverrides {
    pub claude_root: Option<Arc<dyn RecoveryPathResolver>>,
    pub codex_store: Option<Arc<dyn RecoveryCodexStoreResolver>>,
    pub opencode_database: Option<PathBuf>,
    pub amplifier_root: Option<Arc<dyn RecoveryPathResolver>>,
}

/// Mutable provider roots are resolved inside every admitted registry batch.
/// Implementations may read config/environment, but construction never does.
pub(crate) trait RecoveryPathResolver: Send + Sync {
    fn resolve(&self) -> std::io::Result<PathBuf>;
}

/// Codex resolves rollout/config and SQLite roots independently. Returning
/// both from one per-batch call prevents a config change from producing a
/// mixed-root proof.
pub(crate) trait RecoveryCodexStoreResolver: Send + Sync {
    fn resolve(&self) -> std::io::Result<freshell_sessions::codex_exact::CodexExactStore>;
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
    fn lookup_many_blocking(
        &self,
        queries: &[ExactRecoveryQuery],
    ) -> ExactRecoveryProviderSnapshot {
        let _resolved_location = match self.source.resolve() {
            Ok(location) => location,
            Err(_) => {
                return queries
                    .iter()
                    .map(|query| {
                        (
                            query.key.clone(),
                            ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Retryable(
                                freshell_recovery::ExactRecoveryIssue::StoreReadFailed,
                            )),
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
            .map(|query| {
                (
                    query.key.clone(),
                    ExactRecoveryProviderResult::unscoped(ExactRecoveryState::ProviderUnavailable),
                )
            })
            .collect()
    }
}

fn store_read_failed(
    provider: DurableRecoveryProvider,
    queries: &[ExactRecoveryQuery],
) -> ExactRecoveryProviderSnapshot {
    tracing::warn!(
        provider = provider.as_str(),
        issue = freshell_recovery::ExactRecoveryIssue::StoreReadFailed.code(),
        "exact_recovery_provider_root_resolution_failed"
    );
    queries
        .iter()
        .map(|query| {
            (
                query.key.clone(),
                ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Retryable(
                    freshell_recovery::ExactRecoveryIssue::StoreReadFailed,
                )),
            )
        })
        .collect()
}

struct ClaudeRecoveryProvider {
    root: Arc<dyn RecoveryPathResolver>,
}

impl ExactRecoveryProvider for ClaudeRecoveryProvider {
    fn lookup_many_blocking(
        &self,
        queries: &[ExactRecoveryQuery],
    ) -> ExactRecoveryProviderSnapshot {
        match self.root.resolve() {
            Ok(root) => {
                freshell_freshagent::lookup_claude_exact_many_for_selected_root(&root, queries)
            }
            Err(_) => store_read_failed(DurableRecoveryProvider::Claude, queries),
        }
    }
}

struct CodexRecoveryProvider {
    store: Arc<dyn RecoveryCodexStoreResolver>,
}

impl ExactRecoveryProvider for CodexRecoveryProvider {
    fn lookup_many_blocking(
        &self,
        queries: &[ExactRecoveryQuery],
    ) -> ExactRecoveryProviderSnapshot {
        match self.store.resolve() {
            Ok(store) => {
                freshell_sessions::codex_exact::lookup_codex_exact_many_in_store(&store, queries)
            }
            Err(_) => store_read_failed(DurableRecoveryProvider::Codex, queries),
        }
    }
}

pub(crate) fn build_recovery_provider_registry(
    overrides: RecoveryProviderOverrides,
) -> Result<RecoveryProviderRegistry, RegistryRegistrationError> {
    let mut registry = RecoveryProviderRegistry::new();
    if let Some(root) = overrides.claude_root {
        registry.register(
            DurableRecoveryProvider::Claude,
            Arc::new(ClaudeRecoveryProvider { root }),
        )?;
    }
    if let Some(store) = overrides.codex_store {
        registry.register(
            DurableRecoveryProvider::Codex,
            Arc::new(CodexRecoveryProvider { store }),
        )?;
    }
    let configured = [
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
        prepare_exact_recovery_query, BlockingExactRecoveryProbe, DurableRecoveryProvider,
        ExactRecoveryIssue, ExactRecoveryState, MaterializationState,
    };
    use freshell_sessions::codex_exact::CodexExactStore;
    use rusqlite::{params, Connection};

    use super::{
        build_recovery_provider_registry, RecoveryCodexStoreResolver, RecoveryPathResolver,
        RecoveryProviderOverrides,
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

    #[derive(Debug)]
    struct FixedCodexResolver(CodexExactStore);

    impl RecoveryCodexStoreResolver for FixedCodexResolver {
        fn resolve(&self) -> std::io::Result<CodexExactStore> {
            Ok(self.0.clone())
        }
    }

    fn fixed_codex(codex_home: &str, sqlite_home: &str) -> Arc<dyn RecoveryCodexStoreResolver> {
        Arc::new(FixedCodexResolver(CodexExactStore {
            codex_home: PathBuf::from(codex_home),
            sqlite_home: PathBuf::from(sqlite_home),
        }))
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
                    codex_store: Some(fixed_codex("/isolated/codex", "/isolated/codex-state")),
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
        fn new(path: impl Into<PathBuf>) -> Self {
            Self {
                current: Mutex::new(path.into()),
                resolutions: Mutex::new(Vec::new()),
            }
        }

        fn set(&self, path: impl Into<PathBuf>) {
            *self.current.lock().unwrap() = path.into();
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
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let project = second_root.path().join("projects").join("-workspace");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(format!("{session_id}.jsonl")),
            format!("{{\"sessionId\":\"{session_id}\",\"cwd\":\"/workspace\"}}\n"),
        )
        .unwrap();
        let resolver = Arc::new(MutableResolver::new(first_root.path()));
        let registry = build_recovery_provider_registry(RecoveryProviderOverrides {
            claude_root: Some(resolver.clone()),
            ..Default::default()
        })
        .unwrap();
        let query = prepare_exact_recovery_query(
            "claude",
            &SessionLocator {
                provider: "claude".to_string(),
                session_id: session_id.to_string(),
            },
            Some(PathBuf::from("/workspace")),
            MaterializationState::Unknown,
        )
        .unwrap();

        let first = registry.lookup_many_blocking(std::slice::from_ref(&query));
        resolver.set(second_root.path());
        let second = registry.lookup_many_blocking(std::slice::from_ref(&query));

        assert!(matches!(
            first.get(&query.key),
            Some(ExactRecoveryState::Retryable(
                ExactRecoveryIssue::ArtifactMissing
            ))
        ));
        assert!(matches!(
            second.get(&query.key),
            Some(ExactRecoveryState::Present(_))
        ));
        assert_eq!(
            *resolver.resolutions.lock().unwrap(),
            vec![
                first_root.path().to_path_buf(),
                second_root.path().to_path_buf()
            ],
            "the adapter must not cache a mutable provider root between batches"
        );
    }

    #[test]
    fn claude_adapter_resolves_one_relative_selected_root_against_each_query_cwd() {
        let tree = tempfile::tempdir().unwrap();
        let first_cwd = tree.path().join("one/project");
        let second_cwd = tree.path().join("two/project");
        std::fs::create_dir_all(&first_cwd).unwrap();
        std::fs::create_dir_all(&second_cwd).unwrap();
        let first_id = "550e8400-e29b-41d4-a716-446655440052";
        let second_id = "550e8400-e29b-41d4-a716-446655440053";
        for (cwd, session_id) in [(&first_cwd, first_id), (&second_cwd, second_id)] {
            let slug = cwd
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .encode_utf16()
                .map(|unit| {
                    if matches!(unit, 48..=57 | 65..=90 | 97..=122) {
                        char::from_u32(u32::from(unit)).unwrap()
                    } else {
                        '-'
                    }
                })
                .collect::<String>();
            let project = cwd.parent().unwrap().join("claude/projects").join(slug);
            std::fs::create_dir_all(&project).unwrap();
            std::fs::write(
                project.join(format!("{session_id}.jsonl")),
                format!(
                    "{{\"sessionId\":\"{session_id}\",\"cwd\":{}}}\n",
                    serde_json::to_string(cwd.to_str().unwrap()).unwrap()
                ),
            )
            .unwrap();
        }
        let registry = build_recovery_provider_registry(RecoveryProviderOverrides {
            claude_root: Some(fixed("../claude")),
            ..Default::default()
        })
        .unwrap();
        let queries = [
            prepare_exact_recovery_query(
                "claude",
                &SessionLocator {
                    provider: "claude".to_string(),
                    session_id: first_id.to_string(),
                },
                Some(first_cwd),
                MaterializationState::Observed,
            )
            .unwrap(),
            prepare_exact_recovery_query(
                "claude",
                &SessionLocator {
                    provider: "claude".to_string(),
                    session_id: second_id.to_string(),
                },
                Some(second_cwd),
                MaterializationState::Observed,
            )
            .unwrap(),
        ];

        let snapshot = registry.lookup_many_blocking(&queries);

        assert!(queries.iter().all(|query| matches!(
            snapshot.get(&query.key),
            Some(ExactRecoveryState::Present(_))
        )));
    }

    #[derive(Debug)]
    struct MutableCodexResolver {
        current: Mutex<CodexExactStore>,
        resolutions: Mutex<Vec<CodexExactStore>>,
    }

    impl MutableCodexResolver {
        fn new(store: CodexExactStore) -> Self {
            Self {
                current: Mutex::new(store),
                resolutions: Mutex::new(Vec::new()),
            }
        }

        fn set(&self, store: CodexExactStore) {
            *self.current.lock().unwrap() = store;
        }
    }

    impl RecoveryCodexStoreResolver for MutableCodexResolver {
        fn resolve(&self) -> std::io::Result<CodexExactStore> {
            let store = self.current.lock().unwrap().clone();
            self.resolutions.lock().unwrap().push(store.clone());
            Ok(store)
        }
    }

    #[test]
    fn mutable_codex_store_is_reresolved_for_every_registry_batch() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_store = CodexExactStore {
            codex_home: first.path().join("codex"),
            sqlite_home: first.path().join("state"),
        };
        let second_store = CodexExactStore {
            codex_home: second.path().join("codex"),
            sqlite_home: second.path().join("state"),
        };
        let session_id = "70000000-0000-7000-8000-000000000026";
        let rollout = second_store
            .codex_home
            .join("sessions/2026/07/29")
            .join(format!("rollout-2026-07-29T00-00-00-{session_id}.jsonl"));
        std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&second_store.sqlite_home).unwrap();
        std::fs::write(
            &rollout,
            format!(
                "{{\"timestamp\":\"2026-07-29T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"timestamp\":\"2026-07-29T00:00:00Z\",\"cwd\":\"/workspace\",\"originator\":\"codex_cli_rs\",\"cli_version\":\"0.145.0\"}}}}\n"
            ),
        )
        .unwrap();
        let database = Connection::open(second_store.sqlite_home.join("state_5.sqlite")).unwrap();
        database
            .execute_batch(
                "
                CREATE TABLE _sqlx_migrations (
                    version INTEGER PRIMARY KEY,
                    success INTEGER NOT NULL
                );
                INSERT INTO _sqlx_migrations(version, success) VALUES (42, 1);
                CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL
                );
                ",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO threads(id, rollout_path) VALUES (?1, ?2)",
                params![session_id, rollout.to_string_lossy()],
            )
            .unwrap();
        drop(database);
        let resolver = Arc::new(MutableCodexResolver::new(first_store.clone()));
        let registry = build_recovery_provider_registry(RecoveryProviderOverrides {
            codex_store: Some(resolver.clone()),
            ..Default::default()
        })
        .unwrap();
        let query = prepare_exact_recovery_query(
            "codex",
            &SessionLocator {
                provider: "codex".to_string(),
                session_id: session_id.to_string(),
            },
            Some(PathBuf::from("/workspace")),
            MaterializationState::Observed,
        )
        .unwrap();

        let first_result = registry.lookup_many_blocking(std::slice::from_ref(&query));
        resolver.set(second_store.clone());
        let second_result = registry.lookup_many_blocking(std::slice::from_ref(&query));

        assert!(matches!(
            first_result.get(&query.key),
            Some(ExactRecoveryState::Retryable(
                ExactRecoveryIssue::ArtifactMissing
            ))
        ));
        assert!(matches!(
            second_result.get(&query.key),
            Some(ExactRecoveryState::Present(_))
        ));
        assert_eq!(
            *resolver.resolutions.lock().unwrap(),
            vec![first_store, second_store]
        );
    }

    #[derive(Debug)]
    struct FailingPathResolver;

    impl RecoveryPathResolver for FailingPathResolver {
        fn resolve(&self) -> std::io::Result<PathBuf> {
            Err(std::io::Error::other("injected root resolution failure"))
        }
    }

    #[derive(Debug)]
    struct FailingCodexResolver;

    impl RecoveryCodexStoreResolver for FailingCodexResolver {
        fn resolve(&self) -> std::io::Result<CodexExactStore> {
            Err(std::io::Error::other("injected store resolution failure"))
        }
    }

    #[test]
    fn exact_adapter_resolver_errors_are_retryable_store_read_failures() {
        let cases = [
            (
                RecoveryProviderOverrides {
                    claude_root: Some(Arc::new(FailingPathResolver)),
                    ..Default::default()
                },
                "claude",
                "550e8400-e29b-41d4-a716-446655440000",
            ),
            (
                RecoveryProviderOverrides {
                    codex_store: Some(Arc::new(FailingCodexResolver)),
                    ..Default::default()
                },
                "codex",
                "70000000-0000-7000-8000-000000000027",
            ),
        ];
        for (overrides, provider, session_id) in cases {
            let registry = build_recovery_provider_registry(overrides).unwrap();
            let query = prepare_exact_recovery_query(
                provider,
                &SessionLocator {
                    provider: provider.to_string(),
                    session_id: session_id.to_string(),
                },
                Some(PathBuf::from("/workspace")),
                MaterializationState::Observed,
            )
            .unwrap();

            assert!(matches!(
                registry
                    .lookup_many_blocking(std::slice::from_ref(&query))
                    .get(&query.key),
                Some(ExactRecoveryState::Retryable(
                    ExactRecoveryIssue::StoreReadFailed
                ))
            ));
        }
    }

    #[test]
    fn codex_adapter_proves_a_db_selected_rollout_with_split_roots() {
        let tree = tempfile::tempdir().unwrap();
        let codex_home = tree.path().join("codex");
        let sqlite_home = tree.path().join("state");
        let session_id = "70000000-0000-7000-8000-000000000001";
        let rollout = codex_home
            .join("sessions/2026/07/29")
            .join(format!("rollout-2026-07-29T00-00-00-{session_id}.jsonl"));
        std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&sqlite_home).unwrap();
        std::fs::write(
            &rollout,
            format!(
                "{{\"timestamp\":\"2026-07-29T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"timestamp\":\"2026-07-29T00:00:00Z\",\"cwd\":\"/workspace\",\"originator\":\"codex_cli_rs\",\"cli_version\":\"0.145.0\",\"model_provider\":null,\"base_instructions\":null}}}}\n"
            ),
        )
        .unwrap();
        let database = Connection::open(sqlite_home.join("state_5.sqlite")).unwrap();
        database
            .execute_batch(
                "
                CREATE TABLE _sqlx_migrations (
                    version INTEGER PRIMARY KEY,
                    success INTEGER NOT NULL
                );
                INSERT INTO _sqlx_migrations(version, success) VALUES (42, 1);
                CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL
                );
                ",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO threads(id, rollout_path) VALUES (?1, ?2)",
                params![session_id, rollout.to_string_lossy()],
            )
            .unwrap();
        drop(database);
        let registry = build_recovery_provider_registry(RecoveryProviderOverrides {
            codex_store: Some(Arc::new(FixedCodexResolver(CodexExactStore {
                codex_home,
                sqlite_home,
            }))),
            ..Default::default()
        })
        .unwrap();
        let query = prepare_exact_recovery_query(
            "codex",
            &SessionLocator {
                provider: "codex".to_string(),
                session_id: session_id.to_string(),
            },
            Some(PathBuf::from("/workspace")),
            MaterializationState::Observed,
        )
        .unwrap();

        assert!(matches!(
            registry
                .lookup_many_blocking(std::slice::from_ref(&query))
                .get(&query.key),
            Some(ExactRecoveryState::Present(_))
        ));
    }
}
