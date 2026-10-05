use super::*;
use crate::directory_index::{CodexSource, SessionSource};
use serde_json::json;

const THREAD: &str = "11111111-1111-4111-8111-111111111111";
const MIDDLE: &str = "22222222-2222-4222-8222-222222222222";
const HEAD: &str = "33333333-3333-4333-8333-333333333333";

struct Fixture {
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("freshell-codex-history-{}", Uuid::new_v4()));
        fs::create_dir_all(home.join("sessions/2026/10/01")).unwrap();
        Self { home }
    }
    fn write(&self, timestamp: &str, physical: &str, content: &str) -> PathBuf {
        let ids = if physical == THREAD {
            THREAD.to_owned()
        } else {
            format!("{THREAD}_{physical}")
        };
        let path = self
            .home
            .join("sessions/2026/10/01")
            .join(format!("rollout-{timestamp}-{ids}.jsonl"));
        fs::write(&path, content).unwrap();
        path
    }
    fn entries(&self, paths: &[PathBuf]) -> Vec<CodexSegmentEntry> {
        let source = CodexSource::new(self.home.clone());
        paths
            .iter()
            .map(|path| CodexSegmentEntry {
                path: path.clone(),
                item: source.parse(path),
                evidence: Some(scan_codex_file_bytes_evidence(&fs::read(path).unwrap())),
            })
            .collect()
    }
    fn resolver(&self) -> CodexHistoryResolver {
        CodexHistoryResolver::new(self.home.clone())
    }
    fn select(&self, path: &Path, archived: bool) {
        let db = Connection::open(self.home.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, history_mode TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)").unwrap();
        db.execute("INSERT OR REPLACE INTO threads(id,rollout_path,history_mode,archived) VALUES (?1,?2,'paginated',?3)", rusqlite::params![THREAD,path.to_str().unwrap(),archived as i64]).unwrap();
    }
    fn pair(&self) -> (PathBuf, PathBuf, String) {
        // Retain only metadata; the old first user message is superseded.
        let prefix = header(0, "2026-10-01T00:00:00Z", "/fixture/old", "0.159.2", None);
        let root = self.write(
            "2026-10-01T00-00-00",
            THREAD,
            &(prefix.clone() + &user(1, "2026-10-01T00:00:01Z", "Superseded question")),
        );
        let head = self.write(
            "2026-10-01T00-01-00",
            HEAD,
            &(header(
                1,
                "2026-10-01T00:01:00Z",
                "/fixture/current",
                "0.159.3",
                Some(base(THREAD, &prefix, 1)),
            ) + &user(2, "2026-10-01T00:01:01Z", "Current question")),
        );
        (root, head, prefix)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.home).unwrap();
    }
}

fn line(value: Value) -> String {
    format!("{value}\n")
}
fn base(physical: &str, prefix: &str, end_ordinal: u64) -> Value {
    json!({"thread_id":physical,"end_byte_offset":prefix.len(),"end_ordinal_exclusive":end_ordinal})
}
fn header(ordinal: u64, timestamp: &str, cwd: &str, version: &str, base: Option<Value>) -> String {
    let mut payload = json!({"id":THREAD,"session_id":THREAD,"timestamp":"1999-01-01T00:00:00Z","cwd":cwd,"source":"vscode","thread_source":"user","cli_version":version,"originator":"codex-tui","history_mode":"paginated"});
    if let Some(base) = base {
        payload["history_base"] = base;
    }
    line(json!({"type":"session_meta","timestamp":timestamp,"ordinal":ordinal,"payload":payload}))
}
fn user(ordinal: u64, timestamp: &str, message: &str) -> String {
    line(
        json!({"type":"event_msg","timestamp":timestamp,"ordinal":ordinal,"payload":{"type":"user_message","message":message}}),
    )
}
fn mutate_header(path: &Path, mutation: impl FnOnce(&mut Value)) {
    let content = fs::read_to_string(path).unwrap();
    let (header, body) = content.split_once('\n').unwrap();
    let mut header: Value = serde_json::from_str(header).unwrap();
    mutation(&mut header);
    fs::write(path, line(header) + body).unwrap();
}
fn assert_unresolved(result: &CodexComposition) {
    assert_eq!(result.unresolved_identities.len(), 1);
    assert_eq!(result.unresolved_identities[0].session_id, THREAD);
    assert!(!result.history_segments.contains_key(THREAD));
    assert!(!result.history_revisions.contains_key(THREAD));
}
fn selected_text(result: &CodexComposition) -> String {
    result.history_segments[THREAD]
        .iter()
        .map(|segment| String::from_utf8(segment.read().unwrap()).unwrap())
        .collect()
}

#[test]
fn reconstructs_header_only_prefix_and_uses_selected_metadata() {
    let fixture = Fixture::new();
    let (root, head, prefix) = fixture.pair();
    let result = fixture
        .resolver()
        .compose(fixture.entries(&[root.clone(), head.clone()]));
    assert!(result.unresolved_identities.is_empty());
    assert_eq!(result.items.len(), 1);
    let row = &result.items[0];
    assert_eq!(row.first_user_message.as_deref(), Some("Current question"));
    assert_eq!(row.cwd.as_deref(), Some("/fixture/current"));
    assert_eq!(row.source_file.as_ref(), Some(&head));
    assert_eq!(row.created_at, Some(1790812800000));
    assert_eq!(
        result.history_segments[THREAD],
        vec![
            CodexHistorySegment {
                path: root,
                end: Some(CodexHistoryBoundary {
                    end_byte_offset: prefix.len() as u64,
                    end_ordinal_exclusive: 1
                })
            },
            CodexHistorySegment {
                path: head,
                end: None
            },
        ]
    );
    assert!(!selected_text(&result).contains("Superseded question"));
}

#[test]
fn follows_physical_suffix_uuid_through_multiple_retained_prefixes() {
    let fixture = Fixture::new();
    let root_prefix = header(
        0,
        "2026-10-01T00:00:00Z",
        "/fixture/project",
        "0.160.0",
        None,
    ) + &user(1, "2026-10-01T00:00:01Z", "Retained opening question");
    let root = fixture.write(
        "2026-10-01T00-00-00",
        THREAD,
        &(root_prefix.clone() + &user(2, "2026-10-01T00:00:02Z", "Superseded root tail")),
    );
    let middle_prefix = header(
        2,
        "2026-10-01T00:01:00Z",
        "/fixture/project",
        "0.160.0",
        Some(base(THREAD, &root_prefix, 2)),
    ) + &user(3, "2026-10-01T00:01:01Z", "Retained middle question");
    let middle = fixture.write(
        "2026-10-01T00-01-00",
        MIDDLE,
        &(middle_prefix.clone() + &user(4, "2026-10-01T00:01:02Z", "Superseded middle tail")),
    );
    let head = fixture.write(
        "2026-10-01T00-02-00",
        HEAD,
        &(header(
            4,
            "2026-10-01T00:02:00Z",
            "/fixture/project",
            "0.160.0",
            Some(base(MIDDLE, &middle_prefix, 4)),
        ) + &user(5, "2026-10-01T00:02:01Z", "Current final question")),
    );
    let result =
        fixture
            .resolver()
            .compose(fixture.entries(&[head.clone(), root.clone(), middle.clone()]));
    assert!(result.unresolved_identities.is_empty());
    assert_eq!(result.items.len(), 1);
    assert_eq!(
        result.items[0].first_user_message.as_deref(),
        Some("Retained opening question")
    );
    assert_eq!(result.segment_paths[THREAD], vec![root, middle, head]);
    let text = selected_text(&result);
    assert!(text.contains("Retained middle question"));
    assert!(text.contains("Current final question"));
    assert!(!text.contains("Superseded root tail"));
    assert!(!text.contains("Superseded middle tail"));
}

#[test]
fn ignores_malformed_superseded_tail() {
    let fixture = Fixture::new();
    let (root, head, prefix) = fixture.pair();
    let mut invalid = prefix.into_bytes();
    invalid.extend_from_slice(b"invalid JSON\n");
    invalid.push(0xff);
    invalid.extend_from_slice(b" missing final newline");
    fs::write(&root, invalid).unwrap();
    let result = fixture.resolver().compose(fixture.entries(&[root, head]));
    assert!(result.unresolved_identities.is_empty());
    assert_eq!(
        result.items[0].first_user_message.as_deref(),
        Some("Current question")
    );
}

#[test]
fn resolves_archived_prefix_without_publishing_an_archived_row() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    let archive = fixture.home.join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    let archived = archive.join(root.file_name().unwrap());
    fs::rename(root, &archived).unwrap();
    let result = fixture
        .resolver()
        .compose(fixture.entries(std::slice::from_ref(&head)));
    assert!(result.unresolved_identities.is_empty());
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.segment_paths[THREAD], vec![archived, head]);
}

#[test]
fn database_selection_overrides_newer_competing_branch() {
    let fixture = Fixture::new();
    let (root, head, prefix) = fixture.pair();
    let branch = fixture.write(
        "2026-10-01T00-02-00",
        MIDDLE,
        &(header(
            1,
            "2026-10-01T00:02:00Z",
            "/fixture/branch",
            "0.160.0",
            Some(base(THREAD, &prefix, 1)),
        ) + &user(2, "2026-10-01T00:02:01Z", "Other branch question")),
    );
    fixture.select(&head, false);
    let paths = [root, head.clone(), branch.clone()];
    let mut resolver = fixture.resolver();
    let first = resolver.compose(fixture.entries(&paths));
    assert_eq!(first.items.len(), 1);
    assert_eq!(
        first.items[0].first_user_message.as_deref(),
        Some("Current question")
    );
    fixture.select(&branch, false);
    let second = resolver.compose(fixture.entries(&paths));
    assert_eq!(second.items[0].source_file.as_ref(), Some(&branch));
    assert_eq!(
        second.items[0].first_user_message.as_deref(),
        Some("Other branch question")
    );
    assert_ne!(
        first.history_revisions[THREAD],
        second.history_revisions[THREAD]
    );
}

#[test]
fn archived_database_selection_keeps_same_thread_files_hidden() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    fixture.select(&head, true);
    let result = fixture.resolver().compose(fixture.entries(&[root, head]));
    assert!(result.items.is_empty());
    assert!(result.unresolved_identities.is_empty());
}

#[test]
fn archived_selection_keeps_noncanonical_copies_hidden_without_warnings() {
    for warm_cache in [false, true] {
        let fixture = Fixture::new();
        let (root, head, _) = fixture.pair();
        let mut resolver = fixture.resolver();
        if warm_cache {
            let result = resolver.compose(fixture.entries(&[root.clone(), head.clone()]));
            assert_eq!(result.items.len(), 1);
        }
        let copy = head.parent().unwrap().join("copy.jsonl");
        fs::copy(&head, &copy).unwrap();
        fixture.select(&head, true);
        let result = resolver.compose(fixture.entries(&[root, head, copy]));
        assert!(result.items.is_empty());
        assert!(result.unresolved_identities.is_empty());
        assert!(result.history_segments.is_empty());
        assert!(result.history_revisions.is_empty());
        assert!(resolver.warnings.is_empty());
        assert!(resolver.cache.is_empty());
    }
}

#[test]
fn stale_database_selection_never_falls_back_to_an_older_file() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    fixture.select(&head, false);
    fs::remove_file(&head).unwrap();
    // Preserve the discovered reference-bearing member: selection remains
    // authoritative even when the selected file disappears after discovery.
    let head_entry = CodexSegmentEntry {
        path: head.clone(),
        item: None,
        evidence: Some(scan_codex_file_bytes_evidence(
            header(
                1,
                "2026-10-01T00:01:00Z",
                "/fixture/current",
                "0.160.0",
                Some(json!({"thread_id":THREAD,"end_byte_offset":1,"end_ordinal_exclusive":1})),
            )
            .as_bytes(),
        )),
    };
    let mut entries = fixture.entries(&[root]);
    entries.push(head_entry);
    let mut resolver = fixture.resolver();
    let result = resolver.compose(entries);
    assert_unresolved(&result);
    assert_eq!(resolver.warnings[THREAD].0, "selected_head_missing");
}

#[test]
fn unreadable_database_does_not_choose_a_filesystem_branch() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    fs::write(fixture.home.join("state_5.sqlite"), "not SQLite").unwrap();
    let mut resolver = fixture.resolver();
    let result = resolver.compose(fixture.entries(&[root, head]));
    assert_unresolved(&result);
    assert_eq!(resolver.warnings[THREAD].0, "state_db_unreadable");
}

#[test]
fn missing_prefix_is_unresolved_even_for_one_renderable_head() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    fs::remove_file(root).unwrap();
    let mut resolver = fixture.resolver();
    let result = resolver.compose(fixture.entries(&[head]));
    assert_unresolved(&result);
    assert_eq!(resolver.warnings[THREAD].0, "missing_reference");
}

#[test]
fn invalid_byte_or_ordinal_cutoffs_remain_unresolved() {
    for case in [
        "past_eof",
        "inside_record",
        "ordinal_too_large",
        "ordinal_too_small",
        "zero_byte",
        "zero_ordinal",
        "missing_ordinal",
        "invalid_physical_id",
    ] {
        let fixture = Fixture::new();
        let (root, head, prefix) = fixture.pair();
        mutate_header(&head, |header| {
            let base = &mut header["payload"]["history_base"];
            match case {
                "past_eof" => base["end_byte_offset"] = json!(999999),
                "inside_record" => base["end_byte_offset"] = json!(prefix.len() - 1),
                "ordinal_too_large" => base["end_ordinal_exclusive"] = json!(2),
                "ordinal_too_small" => {
                    base["end_byte_offset"] = json!(fs::metadata(&root).unwrap().len())
                }
                "zero_byte" => base["end_byte_offset"] = json!(0),
                "zero_ordinal" => base["end_ordinal_exclusive"] = json!(0),
                "missing_ordinal" => {
                    base.as_object_mut()
                        .unwrap()
                        .remove("end_ordinal_exclusive");
                }
                "invalid_physical_id" => base["thread_id"] = json!("not-a-uuid"),
                _ => unreachable!(),
            }
        });
        let result = fixture.resolver().compose(fixture.entries(&[root, head]));
        assert_unresolved(&result);
    }
}

#[test]
fn selected_records_require_contiguous_ordinals() {
    for ordinal in [None, Some(0), Some(1), Some(3)] {
        let fixture = Fixture::new();
        let (root, head, _) = fixture.pair();
        let content = fs::read_to_string(&head).unwrap();
        let (header, body) = content.split_once('\n').unwrap();
        let mut record: Value = serde_json::from_str(body.trim()).unwrap();
        match ordinal {
            Some(ordinal) => record["ordinal"] = json!(ordinal),
            None => {
                record.as_object_mut().unwrap().remove("ordinal");
            }
        }
        fs::write(&head, format!("{header}\n{}", line(record))).unwrap();
        assert_unresolved(&fixture.resolver().compose(fixture.entries(&[root, head])));
    }
}

#[test]
fn selected_ancestor_requires_matching_logical_identity_and_root_metadata() {
    for field in [
        "id",
        "session_id",
        "history_mode",
        "source",
        "thread_source",
        "parent_thread_id",
        "cli_version",
    ] {
        let fixture = Fixture::new();
        let (root, head, prefix) = fixture.pair();
        mutate_header(&root, |header| {
            header["payload"][field] = match field {
                "id" | "session_id" | "parent_thread_id" => json!(MIDDLE),
                "cli_version" => json!(""),
                _ => json!("unsupported"),
            };
        });
        // Identity/metadata mutation changes prefix byte length; retain the
        // actual entire header so this tests the header rather than a cut.
        let updated = fs::read_to_string(&root)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_owned()
            + "\n";
        assert_ne!(updated, prefix);
        mutate_header(&head, |header| {
            header["payload"]["history_base"]["end_byte_offset"] = json!(updated.len());
        });
        assert_unresolved(&fixture.resolver().compose(fixture.entries(&[root, head])));
    }
}

#[test]
fn prefix_search_reader_rejects_changed_invalid_boundaries() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    let result = fixture
        .resolver()
        .compose(fixture.entries(&[root.clone(), head]));
    fs::write(root, "short\n").unwrap();
    assert_eq!(
        result.history_segments[THREAD][0]
            .read()
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
}

#[test]
fn memoizes_dependencies_and_preserves_revision_when_only_unused_tail_changes() {
    let fixture = Fixture::new();
    let (root, head, prefix) = fixture.pair();
    let paths = [root.clone(), head];
    let mut resolver = fixture.resolver();
    let first = resolver.compose(fixture.entries(&paths));
    assert_eq!(resolver.reads, 2);
    let second = resolver.compose(fixture.entries(&paths));
    assert_eq!(resolver.reads, 2);
    assert_eq!(first.history_revisions, second.history_revisions);
    fs::write(root, prefix + "a different malformed discarded tail\n").unwrap();
    let third = resolver.compose(fixture.entries(&paths));
    assert_eq!(resolver.reads, 4);
    assert!(third.unresolved_identities.is_empty());
    assert_eq!(first.history_revisions, third.history_revisions);
    assert_eq!(first.items, third.items);
}

#[test]
fn newly_ambiguous_physical_reference_invalidates_cached_history() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    fixture.select(&head, false);
    let mut resolver = fixture.resolver();
    let first = resolver.compose(fixture.entries(&[root.clone(), head.clone()]));
    assert!(first.unresolved_identities.is_empty());
    let duplicate = fixture.write(
        "2026-10-01T00-00-30",
        THREAD,
        &fs::read_to_string(&root).unwrap(),
    );
    let second = resolver.compose(fixture.entries(&[root, head, duplicate]));
    assert_unresolved(&second);
    assert_eq!(resolver.warnings[THREAD].0, "ambiguous_rollout");
}

#[test]
fn warns_once_for_a_failure_and_rearms_after_recovery() {
    // The tracing callsite interest cache is process-wide. Isolate capture
    // from parallel tests installing/removing their own default dispatches.
    const CHILD_ENV: &str = "FRESHELL_CODEX_HISTORY_LOG_CAPTURE_CHILD";
    if std::env::var_os(CHILD_ENV).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "codex_history::tests::warns_once_for_a_failure_and_rearms_after_recovery",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated warning capture failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    use tracing_subscriber::layer::SubscriberExt;
    #[derive(Clone)]
    struct Capture(std::sync::Arc<std::sync::Mutex<Vec<BTreeMap<String, String>>>>);
    impl<S: tracing::Subscriber> tracing_subscriber::layer::Layer<S> for Capture {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            struct Fields(BTreeMap<String, String>);
            impl tracing::field::Visit for Fields {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    self.0.insert(field.name().into(), format!("{value:?}"));
                }
                fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                    self.0.insert(field.name().into(), value.into());
                }
            }
            let mut fields = Fields(BTreeMap::new());
            event.record(&mut fields);
            if event.metadata().level() == &tracing::Level::WARN
                && fields.0.get("event").map(String::as_str) == Some("codex_history_unresolved")
            {
                self.0.lock().unwrap().push(fields.0);
            }
        }
    }
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::registry().with(Capture(events.clone()));
    let _guard = tracing::subscriber::set_default(subscriber);
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    let root_bytes = fs::read(&root).unwrap();
    fs::remove_file(&root).unwrap();
    let mut resolver = fixture.resolver();
    assert_unresolved(&resolver.compose(fixture.entries(std::slice::from_ref(&head))));
    assert_unresolved(&resolver.compose(fixture.entries(std::slice::from_ref(&head))));
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(events.lock().unwrap()[0]["reason"], "missing_reference");
    assert_eq!(events.lock().unwrap()[0]["session_id"], THREAD);
    fs::write(&root, root_bytes).unwrap();
    let result = resolver.compose(fixture.entries(&[root.clone(), head.clone()]));
    assert!(result.unresolved_identities.is_empty());
    fs::remove_file(root).unwrap();
    assert_unresolved(&resolver.compose(fixture.entries(&[head])));
    assert_eq!(events.lock().unwrap().len(), 2);
}

#[test]
fn valid_snapshot_survives_complete_or_partial_append_during_read() {
    fn append_complete(path: &Path) {
        if rollout_name(path).is_some_and(|name| name.physical.to_string() == HEAD) {
            use std::io::Write;
            let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
            file.write_all(user(3, "2026-10-01T00:01:02Z", "A newly appended question").as_bytes())
                .unwrap();
        }
    }
    fn append_partial(path: &Path) {
        if rollout_name(path).is_some_and(|name| name.physical.to_string() == HEAD) {
            use std::io::Write;
            fs::OpenOptions::new()
                .append(true)
                .open(path)
                .unwrap()
                .write_all(b"{\"type\":")
                .unwrap();
        }
    }
    for hook in [append_complete as fn(&Path), append_partial as fn(&Path)] {
        let fixture = Fixture::new();
        let (root, head, _) = fixture.pair();
        let paths = [root, head.clone()];
        let mut resolver = fixture.resolver();
        resolver.after_read = Some(hook);
        let first = resolver.compose(fixture.entries(&paths));
        assert!(first.unresolved_identities.is_empty());
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].last_activity_at, 1790812861000);
        // Finish any partial append before the next observation.
        let old = fs::read_to_string(&head).unwrap();
        if old.ends_with("{\"type\":") {
            fs::write(
                &head,
                old.strip_suffix("{\"type\":").unwrap().to_owned()
                    + &user(3, "2026-10-01T00:01:02Z", "A newly appended question"),
            )
            .unwrap();
        }
        resolver.after_read = None;
        let second = resolver.compose(fixture.entries(&paths));
        assert!(second.unresolved_identities.is_empty());
        assert_eq!(second.items[0].last_activity_at, 1790812862000);
        assert_ne!(
            first.history_revisions[THREAD],
            second.history_revisions[THREAD]
        );
        assert_eq!(
            resolver.reads, 4,
            "new bytes must not share the old snapshot's cache stamp"
        );
    }
}

#[test]
fn selected_token_usage_and_activity_exclude_superseded_tail() {
    fn usage(ordinal: u64, timestamp: &str, total: u64) -> String {
        line(
            json!({"type":"event_msg","timestamp":timestamp,"ordinal":ordinal,"payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":total-1,"output_tokens":1,"total_tokens":total}}}}),
        )
    }
    let fixture = Fixture::new();
    let prefix = header(
        0,
        "2026-10-01T00:00:00Z",
        "/fixture/project",
        "0.160.0",
        None,
    ) + &user(1, "2026-10-01T00:00:01Z", "Opening question")
        + &usage(2, "2026-10-01T00:00:02Z", 100);
    let root = fixture.write(
        "2026-10-01T00-00-00",
        THREAD,
        &(prefix.clone()
            + &user(3, "2026-10-01T23:59:58Z", "Superseded late question")
            + &usage(4, "2026-10-01T23:59:59Z", 9999)),
    );
    let head = fixture.write(
        "2026-10-01T00-01-00",
        HEAD,
        &(header(
            3,
            "2026-10-01T00:01:00Z",
            "/fixture/current",
            "0.160.0",
            Some(base(THREAD, &prefix, 3)),
        ) + &user(4, "2026-10-01T00:01:01Z", "Current late question")),
    );
    let result = fixture.resolver().compose(fixture.entries(&[root, head]));
    assert!(result.unresolved_identities.is_empty());
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].last_activity_at, 1790812861000);
    assert_eq!(
        result.items[0].token_usage.as_ref().unwrap().total_tokens,
        100
    );
    assert_eq!(
        result.items[0].token_usage.as_ref().unwrap().input_tokens,
        99
    );
}

#[test]
fn filesystem_fallback_uses_filename_timestamp_then_physical_uuid() {
    let fixture = Fixture::new();
    let (root, head, prefix) = fixture.pair();
    // MIDDLE has a lower UUID despite being added later to discovery.
    let same_second = fixture.write(
        "2026-10-01T00-01-00",
        MIDDLE,
        &(header(
            1,
            "2026-10-01T00:01:00Z",
            "/fixture/tie",
            "0.160.0",
            Some(base(THREAD, &prefix, 1)),
        ) + &user(2, "2026-10-01T00:01:01Z", "Tie branch")),
    );
    let mut resolver = fixture.resolver();
    let first =
        resolver.compose(fixture.entries(&[head.clone(), root.clone(), same_second.clone()]));
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.items[0].source_file.as_ref(), Some(&head));
    let latest = fixture.write(
        "2026-10-01T00-02-00",
        MIDDLE,
        &(header(
            1,
            "2026-10-01T00:02:00Z",
            "/fixture/latest",
            "0.160.0",
            Some(base(THREAD, &prefix, 1)),
        ) + &user(2, "2026-10-01T00:02:01Z", "Newest branch")),
    );
    fs::remove_file(same_second).unwrap();
    let second = resolver.compose(fixture.entries(&[latest.clone(), root, head]));
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].source_file.as_ref(), Some(&latest));
}

#[test]
fn cyclic_references_remain_unresolved() {
    let fixture = Fixture::new();
    let middle_prefix = header(
        5,
        "2026-10-01T00:00:00Z",
        "/fixture/project",
        "0.160.0",
        Some(json!({"thread_id":HEAD,"end_byte_offset":1,"end_ordinal_exclusive":5})),
    ) + &user(6, "2026-10-01T00:00:01Z", "Retained question six")
        + &user(7, "2026-10-01T00:00:02Z", "Retained question seven")
        + &user(8, "2026-10-01T00:00:03Z", "Retained question eight")
        + &user(9, "2026-10-01T00:00:04Z", "Retained question nine");
    let head_header = header(
        10,
        "2026-10-01T00:01:00Z",
        "/fixture/project",
        "0.160.0",
        Some(base(MIDDLE, &middle_prefix, 10)),
    );
    let middle = fixture.write("2026-10-01T00-00-00", MIDDLE, &middle_prefix);
    let head = fixture.write("2026-10-01T00-01-00", HEAD, &head_header);
    let mut resolver = fixture.resolver();
    assert_unresolved(&resolver.compose(fixture.entries(&[middle, head])));
    assert_eq!(resolver.warnings[THREAD].0, "cycle");
}

#[test]
fn standalone_replacement_without_history_base_supersedes_original_file() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    fs::write(
        &head,
        header(
            0,
            "2026-10-01T00:01:00Z",
            "/fixture/replaced",
            "0.160.0",
            None,
        ) + &user(1, "2026-10-01T00:01:01Z", "Entirely replaced conversation"),
    )
    .unwrap();
    for use_database in [false, true] {
        if use_database {
            fixture.select(&head, false);
        }
        let result = fixture
            .resolver()
            .compose(fixture.entries(&[root.clone(), head.clone()]));
        assert!(result.unresolved_identities.is_empty());
        assert_eq!(result.items.len(), 1);
        assert_eq!(
            result.items[0].first_user_message.as_deref(),
            Some("Entirely replaced conversation")
        );
        assert_eq!(result.items[0].source_file.as_ref(), Some(&head));
        // No prefix is inherited, so the selected replacement itself is the
        // reconstruction root; superseded creation metadata is not inferred.
        assert_eq!(result.items[0].created_at, Some(1790812860000));
        assert_eq!(result.segment_paths[THREAD], vec![head.clone()]);
        assert!(!selected_text(&result).contains("Superseded question"));
    }
}

#[test]
fn fresh_resolver_hides_original_when_database_selected_replacement_is_archived() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    let archive = fixture.home.join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    let archived = archive.join(head.file_name().unwrap());
    fs::rename(head, &archived).unwrap();
    fixture.select(&archived, true);
    let result = fixture.resolver().compose(fixture.entries(&[root]));
    assert!(result.items.is_empty());
    assert!(result.unresolved_identities.is_empty());
}

#[test]
fn cached_archived_dependencies_are_rechecked_without_active_file_changes() {
    for operation in ["mutation", "removal", "move"] {
        let fixture = Fixture::new();
        let (root, head, _) = fixture.pair();
        let archive = fixture.home.join("archived_sessions");
        fs::create_dir_all(&archive).unwrap();
        let archived = archive.join(root.file_name().unwrap());
        fs::rename(root, &archived).unwrap();
        let active_entries = fixture.entries(std::slice::from_ref(&head));
        let mut resolver = fixture.resolver();
        let first = resolver.compose(active_entries.clone());
        assert!(first.unresolved_identities.is_empty());
        let moved = archive.join("moved").join(archived.file_name().unwrap());
        match operation {
            "mutation" => {
                let content = fs::read_to_string(&archived)
                    .unwrap()
                    .replace("2026-10-01T00:00:00Z", "2026-10-01T00:00:05Z")
                    + "ignored superseded append\n";
                fs::write(&archived, content).unwrap();
            }
            "removal" => fs::remove_file(&archived).unwrap(),
            "move" => {
                fs::create_dir_all(moved.parent().unwrap()).unwrap();
                fs::rename(&archived, &moved).unwrap();
            }
            _ => unreachable!(),
        }
        let second = resolver.compose(active_entries);
        match operation {
            "mutation" => {
                assert!(second.unresolved_identities.is_empty());
                assert_eq!(second.items[0].created_at, Some(1790812805000));
                assert_ne!(first.history_revisions, second.history_revisions);
            }
            "removal" => assert_unresolved(&second),
            "move" => {
                assert!(second.unresolved_identities.is_empty());
                assert_eq!(second.segment_paths[THREAD], vec![moved, head]);
                assert_eq!(first.history_revisions, second.history_revisions);
                assert_ne!(first.history_segments, second.history_segments);
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn truncation_during_read_is_diagnosed_instead_of_cached() {
    fn truncate(path: &Path) {
        if rollout_name(path).is_some_and(|name| name.physical.to_string() == HEAD) {
            fs::write(path, b"truncated\n").unwrap();
        }
    }
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    let mut resolver = fixture.resolver();
    resolver.after_read = Some(truncate);
    let result = resolver.compose(fixture.entries(&[root, head]));
    assert_unresolved(&result);
    assert_eq!(resolver.warnings[THREAD].0, "source_changed");
}

#[test]
fn marker_free_non_paginated_single_files_preserve_existing_display() {
    for mode in ["legacy", "full", "unsupported"] {
        for use_database in [false, true] {
            let fixture = Fixture::new();
            let (root, head, _) = fixture.pair();
            fs::remove_file(root).unwrap();
            fs::write(
                &head,
                header(
                    0,
                    "2026-10-01T00:01:00Z",
                    "/fixture/project",
                    "0.160.0",
                    None,
                ) + &user(
                    1,
                    "2026-10-01T00:01:01Z",
                    "Existing single file conversation",
                ),
            )
            .unwrap();
            mutate_header(&head, |header| {
                header["payload"]["history_mode"] = json!(mode);
            });
            if use_database {
                fixture.select(&head, false);
                let connection = Connection::open(fixture.home.join("state_5.sqlite")).unwrap();
                connection
                    .execute(
                        "UPDATE threads SET history_mode=?1 WHERE id=?2",
                        [mode, THREAD],
                    )
                    .unwrap();
            }
            let result = fixture
                .resolver()
                .compose(fixture.entries(std::slice::from_ref(&head)));
            assert!(
                result.unresolved_identities.is_empty(),
                "marker-free {mode} file must retain prior single-file behavior"
            );
            assert_eq!(result.items.len(), 1);
            assert_eq!(
                result.items[0].first_user_message.as_deref(),
                Some("Existing single file conversation")
            );
            assert!(!result.history_segments.contains_key(THREAD));
        }
    }
}

#[test]
fn single_explicit_fork_or_subagent_reference_preserves_own_file_display() {
    for marker in [
        "forked_from_id",
        "parent_thread_id",
        "subagent_history_start_ordinal",
        "is_subagent",
        "source.subagent",
    ] {
        let fixture = Fixture::new();
        let (_, head, _) = fixture.pair();
        mutate_header(&head, |header| match marker {
            "subagent_history_start_ordinal" => header["payload"][marker] = json!(1),
            "is_subagent" => header["payload"][marker] = json!(true),
            "source.subagent" => {
                header["payload"]["source"] =
                    json!({"subagent":{"thread_spawn":{"parent_thread_id":MIDDLE,"depth":1}}})
            }
            _ => {
                header["payload"][marker] = json!(MIDDLE);
                header["payload"]["session_id"] = json!(MIDDLE);
            }
        });
        let result = fixture
            .resolver()
            .compose(fixture.entries(std::slice::from_ref(&head)));
        assert!(
            result.unresolved_identities.is_empty(),
            "single {marker} history retains previous own-file display"
        );
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].source_file.as_ref(), Some(&head));
        assert_eq!(
            result.items[0].first_user_message.as_deref(),
            Some("Current question")
        );
        assert!(!result.history_segments.contains_key(THREAD));
        assert!(!result.history_revisions.contains_key(THREAD));
    }
}

#[test]
fn multiple_same_id_fork_reference_files_stay_quarantined() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    mutate_header(&head, |header| {
        header["payload"]["forked_from_id"] = json!(MIDDLE);
    });
    assert_unresolved(&fixture.resolver().compose(fixture.entries(&[root, head])));
}

#[test]
fn false_subagent_flag_does_not_exempt_a_root_missing_reference() {
    let fixture = Fixture::new();
    let (root, head, _) = fixture.pair();
    fs::remove_file(root).unwrap();
    mutate_header(&head, |header| {
        header["payload"]["is_subagent"] = json!(false);
    });
    assert_unresolved(&fixture.resolver().compose(fixture.entries(&[head])));
}

#[test]
fn superseded_child_header_does_not_poison_retained_root_prefix() {
    let fixture = Fixture::new();
    let (root, head, prefix) = fixture.pair();
    let mut discarded: Value = serde_json::from_str(
        header(1, "2026-10-01T00:00:01Z", "/fixture/child", "0.160.0", None).trim(),
    )
    .unwrap();
    discarded["payload"]["parent_thread_id"] = json!(MIDDLE);
    fs::write(&root, prefix + &line(discarded)).unwrap();
    let result = fixture.resolver().compose(fixture.entries(&[root, head]));
    assert!(result.unresolved_identities.is_empty());
    assert_eq!(result.items.len(), 1);
    assert_eq!(
        result.items[0].first_user_message.as_deref(),
        Some("Current question")
    );
    assert!(result.history_segments.contains_key(THREAD));
}

#[test]
fn noncanonical_root_or_head_copy_quarantines_fresh_and_cached_reference_groups() {
    assert_copy_quarantine_recovery("copy.jsonl", "invalid_filename");
}

#[test]
fn foreign_logical_filename_copy_quarantines_fresh_and_cached_reference_groups() {
    assert_copy_quarantine_recovery(
        &format!("rollout-2026-10-01T00-03-00-{MIDDLE}.jsonl"),
        "identity_mismatch",
    );
}

fn assert_copy_quarantine_recovery(copy_name: &str, expected_reason: &str) {
    for copy_head in [false, true] {
        for warm_cache in [false, true] {
            let fixture = Fixture::new();
            let (root, head, _) = fixture.pair();
            let originals = [root.clone(), head.clone()];
            let mut resolver = fixture.resolver();
            if warm_cache {
                let accepted = resolver.compose(fixture.entries(&originals));
                assert!(accepted.unresolved_identities.is_empty());
                assert_eq!(accepted.items.len(), 1);
            }
            let copy = head.parent().unwrap().join(copy_name);
            fs::copy(if copy_head { &head } else { &root }, &copy).unwrap();
            let candidates = [root.clone(), head.clone(), copy.clone()];
            let rejected = resolver.compose(fixture.entries(&candidates));
            assert_unresolved(&rejected);
            let mut expected_paths = candidates.to_vec();
            expected_paths.sort();
            assert_eq!(
                rejected.unresolved_identities[0].paths, expected_paths,
                "do not lose copied paths from quarantine diagnostics"
            );
            assert_eq!(resolver.warnings[THREAD].0, expected_reason);
            assert!(resolver.warnings[THREAD].1.contains(copy_name));
            fs::remove_file(copy).unwrap();
            let recovered = resolver.compose(fixture.entries(&originals));
            assert!(recovered.unresolved_identities.is_empty());
            assert_eq!(recovered.items.len(), 1);
            assert_eq!(recovered.items[0].source_file.as_ref(), Some(&head));
            assert_eq!(
                recovered.items[0].first_user_message.as_deref(),
                Some("Current question")
            );
            assert!(!resolver.warnings.contains_key(THREAD));
        }
    }
}
