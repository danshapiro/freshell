mod codex {
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use freshell_protocol::SessionLocator;
    use freshell_recovery::{
        DurableRecoveryProvider, ExactRecoveryIssue, ExactRecoveryProviderSnapshot,
        ExactRecoveryQuery, ExactRecoveryState, MaterializationState,
    };
    use freshell_sessions::codex_exact::{
        lookup_codex_exact_many_in_store, resolve_codex_exact_store, CodexExactStore,
    };
    use rusqlite::{params, Connection};

    const ID_ACTIVE: &str = "70000000-0000-7000-8000-000000000001";
    const ID_ARCHIVE: &str = "70000000-0000-4000-8000-000000000002";
    const ID_ZSTD: &str = "70000000-0000-4000-8000-000000000003";

    struct TempTree {
        path: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let label = label.chars().next().unwrap_or('x');
            let path = std::env::temp_dir().join(format!(
                "fc{label}-{}",
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    struct Fixture {
        _tree: TempTree,
        store: CodexExactStore,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let tree = TempTree::new(label);
            let codex_home = tree.path.join("codex");
            let sqlite_home = tree.path.join("state");
            std::fs::create_dir_all(&codex_home).unwrap();
            std::fs::create_dir_all(&sqlite_home).unwrap();
            Self {
                store: CodexExactStore {
                    codex_home,
                    sqlite_home,
                },
                _tree: tree,
            }
        }

        fn db_path(&self) -> PathBuf {
            self.store.sqlite_home.join("state_5.sqlite")
        }

        fn rollout(&self, archived: bool, session_id: &str, compressed: bool) -> PathBuf {
            let root = if archived {
                "archived_sessions"
            } else {
                "sessions"
            };
            let suffix = if compressed { ".jsonl.zst" } else { ".jsonl" };
            self.store
                .codex_home
                .join(root)
                .join("2026")
                .join("07")
                .join("29")
                .join(format!("rollout-2026-07-29T00-00-00-{session_id}{suffix}"))
        }
    }

    fn create_state_db(path: &Path, wal: bool) -> Connection {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let connection = Connection::open(path).unwrap();
        if wal {
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .unwrap();
            connection
                .pragma_update(None, "wal_autocheckpoint", 0)
                .unwrap();
        }
        connection
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
        connection
    }

    fn insert_row(connection: &Connection, session_id: &str, path: &Path) {
        connection
            .execute(
                "INSERT INTO threads(id, rollout_path) VALUES (?1, ?2)",
                params![session_id, path.to_string_lossy()],
            )
            .unwrap();
    }

    fn meta_line(session_id: &str) -> String {
        format!(
        "{{\"timestamp\":\"2026-07-29T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"timestamp\":\"2026-07-29T00:00:00Z\",\"cwd\":\"/workspace\",\"originator\":\"codex_cli_rs\",\"cli_version\":\"0.145.0\",\"model_provider\":null,\"base_instructions\":null}}}}\n"
    )
    }

    fn write_rollout(path: &Path, session_id: &str, leading: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("{leading}{}", meta_line(session_id))).unwrap();
    }

    fn write_zstd_rollout(path: &Path, session_id: &str, leading: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let content = format!("{leading}{}", meta_line(session_id));
        let compressed = zstd::stream::encode_all(content.as_bytes(), 1).unwrap();
        std::fs::write(path, compressed).unwrap();
    }

    fn query(session_id: &str) -> ExactRecoveryQuery {
        freshell_recovery::prepare_exact_recovery_query(
            "codex",
            &SessionLocator {
                provider: "codex".to_string(),
                session_id: session_id.to_string(),
            },
            Some(PathBuf::from("/workspace")),
            MaterializationState::Observed,
        )
        .unwrap()
    }

    #[cfg(unix)]
    fn direct_query(session_id: &str) -> ExactRecoveryQuery {
        ExactRecoveryQuery {
            mode: DurableRecoveryProvider::Codex,
            key: freshell_recovery::ExactRecoveryLookupKey {
                session_ref: SessionLocator {
                    provider: "codex".to_string(),
                    session_id: session_id.to_string(),
                },
                cwd: None,
            },
            materialization: MaterializationState::Unknown,
        }
    }

    fn lookup(fixture: &Fixture, queries: &[ExactRecoveryQuery]) -> ExactRecoveryProviderSnapshot {
        lookup_codex_exact_many_in_store(&fixture.store, queries)
    }

    fn state<'a>(
        snapshot: &'a ExactRecoveryProviderSnapshot,
        query: &ExactRecoveryQuery,
    ) -> &'a ExactRecoveryState {
        &snapshot.get(&query.key).expect("query result").state
    }

    fn assert_present(
        snapshot: &ExactRecoveryProviderSnapshot,
        query: &ExactRecoveryQuery,
    ) -> String {
        let ExactRecoveryState::Present(proof) = state(snapshot, query) else {
            panic!("expected present, got {snapshot:?}");
        };
        assert_eq!(proof.owner_key.provider, "codex");
        assert_eq!(proof.owner_key.session_id, query.key.session_ref.session_id);
        assert_eq!(proof.owner_key.provider_scope, None);
        assert_eq!(proof.resolved_cwd, None);
        assert!(proof.artifact_fingerprint.starts_with("codex:"));
        proof.artifact_fingerprint.clone()
    }

    #[test]
    fn db_selected_active_plain_rollout_is_verified_and_canonical() {
        let fixture = Fixture::new("db-active");
        let selected = fixture.rollout(false, ID_ACTIVE, false);
        write_rollout(&selected, ID_ACTIVE, "");
        let duplicate = fixture
            .store
            .codex_home
            .join("sessions/2026/07/28")
            .join(format!("rollout-2026-07-28T00-00-00-{ID_ACTIVE}.jsonl"));
        write_rollout(&duplicate, ID_ACTIVE, "");
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, ID_ACTIVE, &selected);
        drop(db);
        let requested = query(ID_ACTIVE);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[test]
    fn db_selected_archived_rollout_is_verified() {
        let fixture = Fixture::new("db-archive");
        let selected = fixture.rollout(true, ID_ARCHIVE, false);
        write_rollout(&selected, ID_ARCHIVE, "");
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, ID_ARCHIVE, &selected);
        drop(db);
        let requested = query(ID_ARCHIVE);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[test]
    fn db_selected_zstd_rollout_is_bounded_and_verified() {
        let fixture = Fixture::new("db-zstd");
        let selected = fixture.rollout(false, ID_ZSTD, true);
        write_zstd_rollout(&selected, ID_ZSTD, "");
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, ID_ZSTD, &selected);
        drop(db);
        let requested = query(ID_ZSTD);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[test]
    fn db_selected_custom_filename_is_verified_by_metadata_not_filename() {
        let fixture = Fixture::new("db-custom");
        let session_id = "70000000-0000-4000-8000-000000000028";
        let selected = fixture
            .store
            .codex_home
            .join("sessions/2026/07/29/custom-rollout-name.jsonl");
        write_rollout(&selected, session_id, "");
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, session_id, &selected);
        drop(db);
        let requested = query(session_id);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[test]
    fn native_permitted_leading_records_before_session_meta_are_supported() {
        let fixture = Fixture::new("leaders");
        let session_id = "70000000-0000-4000-8000-000000000004";
        let selected = fixture.rollout(false, session_id, false);
        write_rollout(
            &selected,
            session_id,
            concat!(
            "\n",
            "{\"timestamp\":\"t\",\"type\":\"event_msg\",\"payload\":{}}\n",
            "{\"timestamp\":\"t\",\"type\":\"turn_context\",\"payload\":{}}\n",
            "{\"timestamp\":\"t\",\"type\":\"compacted\",\"payload\":{}}\n",
            "{\"timestamp\":\"t\",\"type\":\"world_state\",\"payload\":{}}\n",
            "{\"timestamp\":\"t\",\"type\":\"inter_agent_communication_metadata\",\"payload\":{}}\n"
        ),
        );
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, session_id, &selected);
        drop(db);
        let requested = query(session_id);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[test]
    fn stale_db_row_falls_back_to_one_unique_owned_rollout() {
        let fixture = Fixture::new("stale-row");
        let session_id = "70000000-0000-4000-8000-000000000005";
        let fallback = fixture.rollout(false, session_id, false);
        write_rollout(&fallback, session_id, "");
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(
            &db,
            session_id,
            &fixture.store.codex_home.join("sessions/missing.jsonl"),
        );
        drop(db);
        let requested = query(session_id);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[test]
    fn rollout_missing_from_db_falls_back_to_active_or_archive() {
        let fixture = Fixture::new("missing-row");
        let session_id = "70000000-0000-4000-8000-000000000006";
        let fallback = fixture.rollout(true, session_id, false);
        write_rollout(&fallback, session_id, "");
        drop(create_state_db(&fixture.db_path(), false));
        let requested = query(session_id);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[test]
    fn fallback_ignores_non_native_prefixes_and_invalid_timestamps() {
        let fixture = Fixture::new("strict-name");
        let wrong_prefix_id = "70000000-0000-4000-8000-000000000029";
        let bad_timestamp_id = "70000000-0000-4000-8000-00000000002a";
        let directory = fixture.store.codex_home.join("sessions/2026/07/29");
        write_rollout(
            &directory.join(format!(
                "other-2026-07-29T00-00-00-{wrong_prefix_id}.jsonl"
            )),
            wrong_prefix_id,
            "",
        );
        write_rollout(
            &directory.join(format!(
                "rollout-2026-99-99T99-99-99-{bad_timestamp_id}.jsonl"
            )),
            bad_timestamp_id,
            "",
        );
        drop(create_state_db(&fixture.db_path(), false));
        let queries = [query(wrong_prefix_id), query(bad_timestamp_id)];
        let snapshot = lookup(&fixture, &queries);

        for requested in &queries {
            assert!(matches!(
                state(&snapshot, requested),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactMissing)
            ));
        }
    }

    #[test]
    fn corrupt_database_never_authorizes_an_otherwise_valid_fallback() {
        let fixture = Fixture::new("corrupt-db");
        let session_id = "70000000-0000-4000-8000-000000000022";
        write_rollout(&fixture.rollout(false, session_id, false), session_id, "");
        std::fs::write(fixture.db_path(), b"not a sqlite database").unwrap();
        let requested = query(session_id);

        assert!(matches!(
            state(
                &lookup(&fixture, std::slice::from_ref(&requested)),
                &requested
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
        ));
    }

    #[test]
    fn future_migration_or_unknown_schema_never_authorizes_fallback() {
        for kind in ["future-version", "bad-schema"] {
            let fixture = Fixture::new(kind);
            let session_id = if kind == "future-version" {
                "70000000-0000-4000-8000-000000000007"
            } else {
                "70000000-0000-4000-8000-000000000008"
            };
            write_rollout(&fixture.rollout(false, session_id, false), session_id, "");
            let db = create_state_db(&fixture.db_path(), false);
            if kind == "future-version" {
                db.execute(
                    "INSERT INTO _sqlx_migrations(version, success) VALUES (43, 1)",
                    [],
                )
                .unwrap();
            } else {
                db.execute_batch(
                    "
                ALTER TABLE threads RENAME TO old_threads;
                CREATE TABLE threads(id TEXT PRIMARY KEY, wrong_path TEXT NOT NULL);
                ",
                )
                .unwrap();
            }
            drop(db);
            let requested = query(session_id);

            assert!(matches!(
                state(
                    &lookup(&fixture, std::slice::from_ref(&requested)),
                    &requested
                ),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
                    | ExactRecoveryState::Retryable(ExactRecoveryIssue::Unproved)
            ));
        }
    }

    #[test]
    fn composite_thread_primary_key_is_unknown_schema() {
        let fixture = Fixture::new("composite-pk");
        let session_id = "70000000-0000-4000-8000-00000000001f";
        let first = fixture.rollout(false, session_id, false);
        let second = fixture
            .store
            .codex_home
            .join("archived_sessions/2026/07/28")
            .join(format!("rollout-2026-07-28T00-00-00-{session_id}.jsonl"));
        write_rollout(&first, session_id, "");
        write_rollout(&second, session_id, "");
        let db = Connection::open(fixture.db_path()).unwrap();
        db.execute_batch(
            "
            CREATE TABLE _sqlx_migrations (
                version INTEGER PRIMARY KEY,
                success INTEGER NOT NULL
            );
            INSERT INTO _sqlx_migrations(version, success) VALUES (42, 1);
            CREATE TABLE threads (
                id TEXT NOT NULL,
                bucket TEXT NOT NULL,
                rollout_path TEXT NOT NULL,
                PRIMARY KEY(id, bucket)
            );
            ",
        )
        .unwrap();
        db.execute(
            "INSERT INTO threads(id, bucket, rollout_path) VALUES (?1, 'a', ?2)",
            params![session_id, first.to_string_lossy()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO threads(id, bucket, rollout_path) VALUES (?1, 'b', ?2)",
            params![session_id, second.to_string_lossy()],
        )
        .unwrap();
        drop(db);
        let requested = query(session_id);

        assert!(matches!(
            state(
                &lookup(&fixture, std::slice::from_ref(&requested)),
                &requested
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
        ));
    }

    #[test]
    fn wal_visible_committed_row_is_read_without_checkpointing() {
        let fixture = Fixture::new("wal-visible");
        let session_id = "70000000-0000-4000-8000-000000000009";
        let rollout = fixture.rollout(false, session_id, false);
        write_rollout(&rollout, session_id, "");
        let writer = create_state_db(&fixture.db_path(), true);
        insert_row(&writer, session_id, &rollout);
        assert!(fixture.db_path().with_extension("sqlite-wal").exists());
        let requested = query(session_id);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
        drop(writer);
    }

    #[test]
    fn sqlite_busy_is_retryable_and_returns_promptly() {
        let fixture = Fixture::new("busy");
        let db = create_state_db(&fixture.db_path(), false);
        db.execute_batch("BEGIN EXCLUSIVE; UPDATE _sqlx_migrations SET success = success;")
            .unwrap();
        let requested = query("70000000-0000-4000-8000-00000000000a");
        let started = Instant::now();
        let snapshot = lookup(&fixture, std::slice::from_ref(&requested));

        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(matches!(
            state(&snapshot, &requested),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
        ));
        db.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn partial_and_oversized_metadata_are_retryable() {
        let fixture = Fixture::new("partial-oversized");
        drop(create_state_db(&fixture.db_path(), false));
        let partial_id = "70000000-0000-4000-8000-00000000000b";
        let oversized_id = "70000000-0000-4000-8000-00000000000c";
        let partial = fixture.rollout(false, partial_id, false);
        std::fs::create_dir_all(partial.parent().unwrap()).unwrap();
        std::fs::write(
            &partial,
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{partial_id}"),
        )
        .unwrap();
        let oversized = fixture.rollout(false, oversized_id, true);
        let oversized_content = format!(
            "{{\"type\":\"event_msg\",\"payload\":{{\"padding\":\"{}\"}}}}\n{}",
            "x".repeat(2 * 1024 * 1024),
            meta_line(oversized_id)
        );
        std::fs::write(
            &oversized,
            zstd::stream::encode_all(oversized_content.as_bytes(), 1).unwrap(),
        )
        .unwrap();
        let queries = [query(partial_id), query(oversized_id)];
        let snapshot = lookup(&fixture, &queries);

        for requested in &queries {
            assert!(matches!(
                state(&snapshot, requested),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
            ));
        }
    }

    #[test]
    fn oversized_compressed_prefix_is_bounded_before_metadata() {
        let fixture = Fixture::new("zstd-input");
        drop(create_state_db(&fixture.db_path(), false));
        let session_id = "70000000-0000-4000-8000-00000000002b";
        let rollout = fixture.rollout(false, session_id, true);
        std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        let skipped_bytes = 600 * 1024_u32;
        let mut compressed = Vec::with_capacity(skipped_bytes as usize + 1024);
        compressed.extend_from_slice(&0x184D_2A50_u32.to_le_bytes());
        compressed.extend_from_slice(&skipped_bytes.to_le_bytes());
        compressed.resize(compressed.len() + skipped_bytes as usize, 0);
        compressed.extend(
            zstd::stream::encode_all(meta_line(session_id).as_bytes(), 1).unwrap(),
        );
        std::fs::write(rollout, compressed).unwrap();
        let requested = query(session_id);

        assert!(matches!(
            state(
                &lookup(&fixture, std::slice::from_ref(&requested)),
                &requested
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
        ));
    }

    #[test]
    fn structurally_partial_or_invalid_session_meta_never_proves_ownership() {
        let fixture = Fixture::new("meta-shape");
        drop(create_state_db(&fixture.db_path(), false));
        let partial_id = "70000000-0000-4000-8000-00000000001b";
        let invalid_mode_id = "70000000-0000-4000-8000-00000000001c";
        let partial = fixture.rollout(false, partial_id, false);
        std::fs::create_dir_all(partial.parent().unwrap()).unwrap();
        std::fs::write(
            partial,
            format!(
                "{{\"timestamp\":\"2026-07-29T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{partial_id}\",\"cwd\":\"/workspace\"}}}}\n"
            ),
        )
        .unwrap();
        let invalid_mode = fixture.rollout(false, invalid_mode_id, false);
        std::fs::write(
            invalid_mode,
            meta_line(invalid_mode_id).replace(
                "\"base_instructions\":null",
                "\"base_instructions\":null,\"history_mode\":null",
            ),
        )
        .unwrap();
        let queries = [query(partial_id), query(invalid_mode_id)];
        let snapshot = lookup(&fixture, &queries);

        for requested in &queries {
            assert!(matches!(
                state(&snapshot, requested),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
            ));
        }
    }

    #[test]
    fn malformed_known_session_meta_fields_never_prove_ownership() {
        let fixture = Fixture::new("meta-types");
        drop(create_state_db(&fixture.db_path(), false));
        let cases = [
            (
                "70000000-0000-4000-8000-00000000002c",
                "\"model_provider\":7,\"base_instructions\":null",
            ),
            (
                "70000000-0000-4000-8000-00000000002d",
                "\"model_provider\":null,\"base_instructions\":null,\"source\":7",
            ),
            (
                "70000000-0000-4000-8000-00000000002e",
                "\"model_provider\":null,\"base_instructions\":{\"text\":7}",
            ),
            (
                "70000000-0000-4000-8000-00000000002f",
                "\"model_provider\":null,\"base_instructions\":null,\"git\":{\"branch\":7}",
            ),
        ];
        let queries = cases
            .iter()
            .map(|(session_id, fields)| {
                let rollout = fixture.rollout(false, session_id, false);
                let malformed = meta_line(session_id).replace(
                    "\"model_provider\":null,\"base_instructions\":null",
                    fields,
                );
                std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
                std::fs::write(rollout, malformed).unwrap();
                query(session_id)
            })
            .collect::<Vec<_>>();
        let snapshot = lookup(&fixture, &queries);

        for requested in &queries {
            assert!(matches!(
                state(&snapshot, requested),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
            ));
        }
    }

    #[test]
    fn distinct_owned_fallbacks_conflict_but_plain_zstd_siblings_are_one_logical_artifact() {
        let fixture = Fixture::new("duplicates");
        drop(create_state_db(&fixture.db_path(), false));
        let conflict_id = "70000000-0000-4000-8000-00000000000d";
        let sibling_id = "70000000-0000-4000-8000-00000000000e";
        let first = fixture.rollout(false, conflict_id, false);
        write_rollout(&first, conflict_id, "");
        let second = fixture
            .store
            .codex_home
            .join("archived_sessions/2026/07/28")
            .join(format!("rollout-2026-07-28T00-00-00-{conflict_id}.jsonl"));
        write_rollout(&second, conflict_id, "");
        let plain = fixture.rollout(false, sibling_id, false);
        write_rollout(&plain, sibling_id, "");
        let compressed = PathBuf::from(format!("{}.zst", plain.to_string_lossy()));
        write_zstd_rollout(&compressed, sibling_id, "");
        let conflict_query = query(conflict_id);
        let sibling_query = query(sibling_id);
        let snapshot = lookup(&fixture, &[conflict_query.clone(), sibling_query.clone()]);

        assert!(matches!(
            state(&snapshot, &conflict_query),
            ExactRecoveryState::Conflict
        ));
        assert_present(&snapshot, &sibling_query);
    }

    #[test]
    fn foreign_metadata_collision_does_not_suppress_one_unique_owned_fallback() {
        let fixture = Fixture::new("foreign");
        drop(create_state_db(&fixture.db_path(), false));
        let session_id = "70000000-0000-4000-8000-000000000023";
        let foreign_id = "70000000-0000-4000-8000-000000000024";
        let owned = fixture.rollout(false, session_id, false);
        let foreign = fixture
            .store
            .codex_home
            .join("archived_sessions/2026/07/28")
            .join(format!("rollout-2026-07-28T00-00-00-{session_id}.jsonl"));
        write_rollout(&owned, session_id, "");
        write_rollout(&foreign, foreign_id, "");
        let requested = query(session_id);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[cfg(unix)]
    #[test]
    fn hardlinked_fallback_names_are_one_physical_artifact() {
        let fixture = Fixture::new("hardlink");
        drop(create_state_db(&fixture.db_path(), false));
        let session_id = "70000000-0000-4000-8000-000000000025";
        let first = fixture.rollout(false, session_id, false);
        let second = fixture
            .store
            .codex_home
            .join("archived_sessions/2026/07/28")
            .join(format!("rollout-2026-07-28T00-00-00-{session_id}.jsonl"));
        write_rollout(&first, session_id, "");
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        std::fs::hard_link(&first, &second).unwrap();
        let requested = query(session_id);

        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[test]
    fn same_basename_plain_and_zstd_in_different_directories_conflict() {
        let fixture = Fixture::new("cross-dir");
        drop(create_state_db(&fixture.db_path(), false));
        let session_id = "70000000-0000-4000-8000-00000000001d";
        let plain = fixture.rollout(false, session_id, false);
        let compressed = fixture.rollout(true, session_id, true);
        write_rollout(&plain, session_id, "");
        write_zstd_rollout(&compressed, session_id, "");
        let requested = query(session_id);

        assert!(matches!(
            state(
                &lookup(&fixture, std::slice::from_ref(&requested)),
                &requested
            ),
            ExactRecoveryState::Conflict
        ));
    }

    #[test]
    fn db_selected_zstd_defers_to_same_directory_plain_representation() {
        let fixture = Fixture::new("db-sibling");
        let session_id = "70000000-0000-4000-8000-00000000001e";
        let plain = fixture.rollout(false, session_id, false);
        let compressed = fixture.rollout(false, session_id, true);
        std::fs::create_dir_all(plain.parent().unwrap()).unwrap();
        std::fs::write(
            &plain,
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}"),
        )
        .unwrap();
        write_zstd_rollout(&compressed, session_id, "");
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, session_id, &compressed);
        drop(db);
        let requested = query(session_id);

        assert!(matches!(
            state(
                &lookup(&fixture, std::slice::from_ref(&requested)),
                &requested
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
        ));
    }

    #[test]
    fn config_sqlite_home_is_independent_and_wins_over_environment_value() {
        let tree = TempTree::new("split-config");
        let codex_home = tree.path.join("codex");
        let env_sqlite_home = tree.path.join("env-state");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(
            codex_home.join("config.toml"),
            "sqlite_home = \"configured-state\"\n",
        )
        .unwrap();
        let store =
            resolve_codex_exact_store(&codex_home, Some(&env_sqlite_home), &tree.path).unwrap();
        assert_eq!(store.codex_home, codex_home);
        assert_eq!(store.sqlite_home, codex_home.join("configured-state"));

        let fixture = Fixture { store, _tree: tree };
        let session_id = "70000000-0000-4000-8000-00000000000f";
        let rollout = fixture.rollout(false, session_id, false);
        write_rollout(&rollout, session_id, "");
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, session_id, &rollout);
        drop(db);
        let requested = query(session_id);
        assert_present(
            &lookup(&fixture, std::slice::from_ref(&requested)),
            &requested,
        );
    }

    #[cfg(unix)]
    #[test]
    fn db_traversal_outside_and_symlink_escape_are_retryable_without_opening_target() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new("path-escape");
        let outside = fixture._tree.path.join("outside-fifo");
        let outside_c = std::ffi::CString::new(outside.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(outside_c.as_ptr(), 0o600) }, 0);
        let traversal_id = "70000000-0000-4000-8000-000000000010";
        let outside_id = "70000000-0000-4000-8000-000000000011";
        let symlink_id = "70000000-0000-4000-8000-000000000012";
        let escape_link = fixture.rollout(false, symlink_id, false);
        std::fs::create_dir_all(escape_link.parent().unwrap()).unwrap();
        symlink(&outside, &escape_link).unwrap();
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, traversal_id, Path::new("../outside-fifo"));
        insert_row(&db, outside_id, &outside);
        insert_row(&db, symlink_id, &escape_link);
        drop(db);
        let queries = [query(traversal_id), query(outside_id), query(symlink_id)];
        let started = Instant::now();
        let snapshot = lookup(&fixture, &queries);

        assert!(started.elapsed() < Duration::from_millis(250));
        for requested in &queries {
            assert!(matches!(
                state(&snapshot, requested),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
                    | ExactRecoveryState::Retryable(ExactRecoveryIssue::Unproved)
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn fifo_socket_and_device_shaped_db_or_rollout_candidates_return_promptly() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;

        for kind in ["db-fifo", "db-socket"] {
            let fixture = Fixture::new(kind);
            let path = fixture.db_path();
            if kind == "db-fifo" {
                let path_c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(path_c.as_ptr(), 0o600) }, 0);
            } else {
                let _listener = UnixListener::bind(&path).unwrap();
                let requested = query("70000000-0000-4000-8000-000000000013");
                let started = Instant::now();
                let snapshot = lookup(&fixture, std::slice::from_ref(&requested));
                assert!(started.elapsed() < Duration::from_millis(250));
                assert!(matches!(
                    state(&snapshot, &requested),
                    ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
                ));
                continue;
            }
            let requested = query("70000000-0000-4000-8000-000000000014");
            let started = Instant::now();
            let snapshot = lookup(&fixture, std::slice::from_ref(&requested));
            assert!(started.elapsed() < Duration::from_millis(250));
            assert!(matches!(
                state(&snapshot, &requested),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
            ));
        }

        let fixture = Fixture::new("rollout-nonregular");
        drop(create_state_db(&fixture.db_path(), false));
        let ids = [
            "70000000-0000-4000-8000-000000000015",
            "70000000-0000-4000-8000-000000000016",
            "70000000-0000-4000-8000-000000000017",
        ];
        let fifo = fixture.rollout(false, ids[0], false);
        std::fs::create_dir_all(fifo.parent().unwrap()).unwrap();
        let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        let socket = fixture.store.codex_home.join("sessions").join(format!(
            "rollout-2026-07-29T00-00-00-{}.jsonl",
            ids[1]
        ));
        std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
        let _listener = UnixListener::bind(&socket).unwrap();
        let device_link = fixture.rollout(false, ids[2], false);
        symlink("/dev/null", &device_link).unwrap();
        let queries = ids.map(query);
        let started = Instant::now();
        let snapshot = lookup(&fixture, &queries);
        assert!(started.elapsed() < Duration::from_millis(250));
        for requested in &queries {
            assert!(matches!(
                state(&snapshot, requested),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
                    | ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn sqlite_nonregular_sidecars_return_promptly_without_sqlite_opening_them() {
        for suffix in ["-wal", "-shm", "-journal"] {
            let fixture = Fixture::new("db-side");
            drop(create_state_db(&fixture.db_path(), false));
            let mut sidecar = fixture.db_path().as_os_str().to_os_string();
            sidecar.push(suffix);
            let sidecar = PathBuf::from(sidecar);
            let sidecar_c = std::ffi::CString::new(sidecar.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(sidecar_c.as_ptr(), 0o600) }, 0);
            let requested = query("70000000-0000-4000-8000-000000000020");
            let started = Instant::now();
            let snapshot = lookup(&fixture, std::slice::from_ref(&requested));

            assert!(
                started.elapsed() < Duration::from_millis(250),
                "nonregular SQLite {suffix} must be rejected before SQLite opens it"
            );
            assert!(matches!(
                state(&snapshot, &requested),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
            ));
        }
    }

    #[test]
    fn read_only_wal_lookup_preserves_database_and_wal_bytes_across_repeats() {
        let fixture = Fixture::new("bytes");
        let session_id = "70000000-0000-4000-8000-000000000018";
        let rollout = fixture.rollout(false, session_id, false);
        write_rollout(&rollout, session_id, "");
        let writer = create_state_db(&fixture.db_path(), true);
        insert_row(&writer, session_id, &rollout);
        let wal = fixture.db_path().with_extension("sqlite-wal");
        let db_before = std::fs::read(fixture.db_path()).unwrap();
        let wal_before = std::fs::read(&wal).unwrap();
        let requested = query(session_id);

        for _ in 0..3 {
            assert_present(
                &lookup(&fixture, std::slice::from_ref(&requested)),
                &requested,
            );
        }
        assert_eq!(std::fs::read(fixture.db_path()).unwrap(), db_before);
        assert_eq!(std::fs::read(&wal).unwrap(), wal_before);
        drop(writer);
    }

    #[cfg(unix)]
    #[test]
    fn invalid_uuid_is_rejected_before_nonregular_database_io() {
        let fixture = Fixture::new("invalid-before-io");
        let db_path = fixture.db_path();
        let db_c = std::ffi::CString::new(db_path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(db_c.as_ptr(), 0o600) }, 0);
        let requested = direct_query("../not-a-thread");
        let started = Instant::now();
        let snapshot = lookup(&fixture, std::slice::from_ref(&requested));

        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(matches!(
            state(&snapshot, &requested),
            ExactRecoveryState::Invalid(ExactRecoveryIssue::InvalidSessionId)
        ));
    }

    #[test]
    fn batch_deduplicates_repeated_queries_and_resolves_multiple_ids() {
        let fixture = Fixture::new("batch");
        let first_id = "70000000-0000-4000-8000-000000000019";
        let second_id = "70000000-0000-4000-8000-00000000001a";
        let first_path = fixture.rollout(false, first_id, false);
        let second_path = fixture.rollout(true, second_id, false);
        write_rollout(&first_path, first_id, "");
        write_rollout(&second_path, second_id, "");
        let db = create_state_db(&fixture.db_path(), false);
        insert_row(&db, first_id, &first_path);
        drop(db);
        let first = query(first_id);
        let second = query(second_id);
        let snapshot = lookup(
            &fixture,
            &[first.clone(), second.clone(), first.clone(), second.clone()],
        );

        assert_eq!(snapshot.len(), 2);
        assert_present(&snapshot, &first);
        assert_present(&snapshot, &second);
    }
}
