//! Name-reliability Task 11 (D9, RC9): name reads are served from the
//! adopted view without the document lock, and the cross-process check is a
//! cheap stamp peek backed by a periodic full read.
//!
//! Every test drives the REAL store on a temp dir; a "second process" is a
//! second `SessionNames` opened on the same directory — the file lock and
//! the document file are the only things two participants share, exactly as
//! between two real processes.

use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use freshell_freshagent::naming::{NameError, PendingNameInput, RenameNameInput, SessionNaming};
use freshell_protocol::session_names::{
    LegacyCandidateScope, NameIntent, NameSource, NamedProvider, SessionNameRecord, SessionNameRef,
    SessionNameUpdate,
};

use super::super::*;
use super::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn open(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open store")
}

fn pending(id: &str) -> SessionNameRef {
    SessionNameRef::Pending { id: id.to_string() }
}

async fn ensure(store: &Arc<SessionNames>, handle: &str) {
    store
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider: NamedProvider::Claude,
            cwd: Some("/w/store-view".to_string()),
        })
        .await
        .expect("ensure pending");
}

async fn rename_user(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
}

async fn name_of(store: &Arc<SessionNames>, target: &SessionNameRef) -> String {
    store
        .get(vec![target.clone()])
        .await
        .expect("get succeeds")
        .into_iter()
        .next()
        .expect("the record resolves")
        .record
        .name
}

fn raw_document(dir: &Path) -> StoredDocument {
    let bytes = std::fs::read(dir.join(DOCUMENT_FILE_NAME)).expect("raw document exists");
    parse_document(&bytes).expect("raw document parses")
}

/// Take the sidecar lock the way a cooperating participant does (bounded
/// retry), returning the held handle.
fn hold_document_lock(dir: &Path) -> std::fs::File {
    let lock = open_lock_file(&dir.join(LOCK_FILE_NAME)).expect("open the sidecar lock");
    let deadline = Instant::now() + LOCK_RETRY_BUDGET;
    loop {
        match lock.try_lock() {
            Ok(()) => return lock,
            Err(std::fs::TryLockError::WouldBlock) => {
                assert!(Instant::now() < deadline, "the sidecar lock stayed busy");
                std::thread::sleep(LOCK_POLL_INTERVAL);
            }
            Err(error) => panic!("sidecar lock: {error}"),
        }
    }
}

async fn wait_for_lock_held_sentinel(dir: &Path) {
    let sentinel = dir.join(LOCK_HELD_SENTINEL_NAME);
    let deadline = Instant::now() + Duration::from_secs(15);
    while !sentinel.exists() {
        assert!(
            Instant::now() < deadline,
            "the holding participant never signaled that it took the document lock"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// The live-machine shape that made reads slow (RC9): a version-1 document
/// of at least 4.5 MB — 5,000 records, 1,200 idle generation series with
/// 1.5 KB excerpts, 1,600 acknowledged candidate ids and the winning
/// migration evidence that goes with them. Returns the document and the refs
/// of its records in key order.
fn synthetic_load_document() -> (StoredDocument, Vec<SessionNameRef>) {
    const RECORDS: usize = 5_000;
    const IDLE_SERIES: usize = 1_200;
    const EXCERPT_BYTES: usize = 1_536;
    const ACKNOWLEDGED: usize = 1_600;
    let mut document = StoredDocument::initial();
    document.document_generation = 1;
    document.migration.completed = true;
    let mut refs = Vec::with_capacity(RECORDS);
    for i in 0..RECORDS {
        let target = SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: format!("5e55{i:04}-0000-4000-8000-00000000{i:04}"),
        };
        let key = name_ref_key(&target);
        let revision = document.allocate_revision().expect("revision");
        document.records.insert(
            key.clone(),
            SessionNameRecord {
                name_ref: target.clone(),
                name: format!(
                    "Investigate the importer regression number {i:04} in the build pipeline"
                ),
                source: NameSource::FirstMessage,
                revision,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            },
        );
        if i < IDLE_SERIES {
            let excerpt: String = format!("First message {i:04}: ")
                .chars()
                .chain(std::iter::repeat('x'))
                .take(EXCERPT_BYTES)
                .collect();
            document.generation.insert(
                key.clone(),
                GenerationState {
                    status: GenerationStatus::Idle,
                    series_id: format!("series-{i:04}-0000-4000-8000-000000000000"),
                    input_fingerprint: Some(format!("{:064x}", i)),
                    excerpt: Some(excerpt),
                    attempt_ids: Vec::new(),
                    attempt_starts: Vec::new(),
                    consumed: 0,
                    next_due: None,
                    exhausted_at: None,
                },
            );
        }
        if i < ACKNOWLEDGED {
            let candidate_id = format!(
                "import-{i:04}-0000-4000-8000-000000000000:freshell.layout.v3.window-{i:04}:tab-{i:04}-0000-4000-8000-000000000000:pane-{i:04}-0000-4000-8000-000000000000:title"
            );
            document
                .migration
                .acknowledged_candidate_ids
                .push(candidate_id.clone());
            document.migration.winning_evidence.insert(
                key,
                StoredMigrationEvidence {
                    candidate_id,
                    name: format!(
                        "Investigate the importer regression number {i:04} in the build pipeline"
                    ),
                    source: NameSource::FirstMessage,
                    scope: LegacyCandidateScope::Session,
                    explicit_rename_at: None,
                    evidence_key: format!(
                        "freshell.layout.v3.window-{i:04}-0000-4000-8000-000000000000"
                    ),
                    installed_revision: revision,
                },
            );
        }
        refs.push(target);
    }
    (document, refs)
}

fn write_document_before_open(dir: &Path, document: &StoredDocument) -> usize {
    let bytes = serialize_document(document).expect("serialize the synthetic document");
    std::fs::write(dir.join(DOCUMENT_FILE_NAME), &bytes).expect("write the synthetic document");
    bytes.len()
}

// ---------------------------------------------------------------------------
// Lock-free reads
// ---------------------------------------------------------------------------

/// RC9's deterministic red: another participant is mid-transaction (it
/// holds the document lock), and a read still answers at once from the
/// adopted view instead of polling the lock for a second and failing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_do_not_take_the_document_lock() {
    let dir = temp_dir();
    let reader = open(dir.path());
    let target = pending("h-lock-free");
    ensure(&reader, "h-lock-free").await;
    rename_user(&reader, target.clone(), "Readable while locked")
        .await
        .expect("rename");

    // The second participant's transaction takes the lock and holds it.
    let writer = open(dir.path());
    let data_dir = writer.core.data_dir.clone();
    set_test_hooks(&data_dir, vec![TestHook::HoldLock(1_500)]);
    let held = tokio::spawn({
        let writer = Arc::clone(&writer);
        let target = target.clone();
        async move { rename_user(&writer, target, "Committed after the hold").await }
    });
    wait_for_lock_held_sentinel(&data_dir).await;

    let started = Instant::now();
    let read = reader.get(vec![target.clone()]).await;
    let elapsed = started.elapsed();
    let updates = read.expect("a read never fails because another participant holds the lock");
    assert_eq!(updates.len(), 1, "the adopted record answers");
    assert_eq!(updates[0].record.name, "Readable while locked");
    assert!(
        elapsed < Duration::from_millis(50),
        "the read answered without waiting on the lock (took {elapsed:?})"
    );

    held.await
        .expect("the holder task completes")
        .expect("the holder's rename commits after its hold");
    clear_test_hooks(&data_dir);
    assert_eq!(
        name_of(&reader, &target).await,
        "Committed after the hold",
        "once the holder committed, the reader's peek adopts the new document"
    );
}

/// The document changed AND the lock is busy (another participant is
/// mid-commit): the read still never waits — it answers from the adopted
/// view at once, and the next read after the lock frees adopts the change.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_changed_document_under_a_busy_lock_is_read_from_the_view() {
    let dir = temp_dir();
    let reader = open(dir.path());
    let target = pending("h-busy");
    ensure(&reader, "h-busy").await;
    rename_user(&reader, target.clone(), "Adopted name")
        .await
        .expect("rename");
    let writer = open(dir.path());
    rename_user(&writer, target.clone(), "Committed elsewhere")
        .await
        .expect("the other participant commits");

    let held = hold_document_lock(&writer.core.data_dir);
    let started = Instant::now();
    let read = reader.get(vec![target.clone()]).await;
    let elapsed = started.elapsed();
    let updates = read.expect("a busy lock never fails a read");
    assert_eq!(
        updates[0].record.name, "Adopted name",
        "the read answered from the adopted view"
    );
    assert!(
        elapsed < Duration::from_millis(50),
        "the read did not wait for the lock (took {elapsed:?})"
    );
    drop(held);

    assert_eq!(
        name_of(&reader, &target).await,
        "Committed elsewhere",
        "with the lock free the next read adopts the change"
    );
}

/// A second participant's commit is visible to the next read: the stamp
/// peek sees the replaced document, the read adopts it (publishing the
/// delta to this participant's subscribers) and answers the new name.
#[tokio::test]
async fn read_sees_cross_process_commit_via_stamp_peek() {
    let dir = temp_dir();
    let a = open(dir.path());
    let target = pending("h-peek");
    ensure(&a, "h-peek").await;
    rename_user(&a, target.clone(), "Named by A")
        .await
        .expect("A renames");
    assert_eq!(name_of(&a, &target).await, "Named by A");
    let mut subscriber = a.subscribe();

    let b = open(dir.path());
    rename_user(&b, target.clone(), "Committed by B")
        .await
        .expect("B renames");

    assert_eq!(
        name_of(&a, &target).await,
        "Committed by B",
        "A's read adopted B's commit"
    );
    assert_eq!(
        a.core.current_view().document.document_generation,
        raw_document(dir.path()).document_generation,
        "A's view is the document on disk"
    );
    let published = subscriber
        .try_recv()
        .expect("the adoption published the changed record to A's subscribers");
    assert_eq!(published.record.name, "Committed by B");
}

/// An unchanged document costs a stat: neither the peek nor a read takes a
/// store transaction (no lock, no parse) while the stamp still matches.
#[tokio::test]
async fn unchanged_stamp_peek_takes_no_lock_and_parses_nothing() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = pending("h-quiet");
    ensure(&store, "h-quiet").await;
    rename_user(&store, target.clone(), "Quiet name")
        .await
        .expect("rename");
    let data_dir = store.core.data_dir.clone();

    let before = test_store_transaction_count(&data_dir);
    for _ in 0..100 {
        assert!(
            !store
                .adopt_external_if_changed()
                .await
                .expect("the peek succeeds"),
            "nothing changed on disk"
        );
    }
    for _ in 0..100 {
        assert_eq!(name_of(&store, &target).await, "Quiet name");
    }
    assert_eq!(
        test_store_transaction_count(&data_dir),
        before,
        "100 peeks and 100 reads of an unchanged document took no store transaction"
    );
}

/// Where the stamp cannot see a change (an in-place rewrite that keeps the
/// length, inode and mtime — possible on coarse-timestamp filesystems),
/// staleness is bounded by the periodic full check: inside the window the
/// peek trusts the stamp, and once the window elapses the next peek reads
/// the whole document and adopts it.
#[tokio::test]
async fn stale_stamp_window_is_bounded_by_the_periodic_full_check() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = pending("h-window");
    ensure(&store, "h-window").await;
    rename_user(&store, target.clone(), "Name AAAA")
        .await
        .expect("rename");
    let data_dir = store.core.data_dir.clone();
    let doc_path = data_dir.join(DOCUMENT_FILE_NAME);
    set_test_hooks(&data_dir, vec![TestHook::FullCheckIntervalMs(60_000)]);
    // A peek now starts the window from a confirmed full read.
    assert!(!store.adopt_external_if_changed().await.expect("peek"));

    // The seam: a newer generation rewritten IN PLACE (same inode), at the
    // same length, with the mtime put back.
    let stamp_before = stat_stamp(&doc_path).expect("stat");
    let mtime_before = std::fs::metadata(&doc_path)
        .and_then(|metadata| metadata.modified())
        .expect("mtime");
    let mut newer = raw_document(&data_dir);
    let key = name_ref_key(&target);
    let record = newer.records.get_mut(&key).expect("record");
    record.name = "Name BBBB".to_string();
    newer.document_generation += 1;
    let bytes = serialize_document(&newer).expect("serialize");
    assert_eq!(
        bytes.len() as u64,
        stamp_before.len,
        "the seam keeps the length"
    );
    {
        let _lock = hold_document_lock(&data_dir);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&doc_path)
            .expect("open in place");
        file.write_all(&bytes).expect("rewrite in place");
        file.sync_all().expect("sync");
        file.set_times(std::fs::FileTimes::new().set_modified(mtime_before))
            .expect("put the mtime back");
    }
    assert_eq!(
        stat_stamp(&doc_path).expect("stat"),
        stamp_before,
        "the seam forces an equal stamp"
    );

    // Inside the window the peek trusts the stamp.
    assert!(
        !store.adopt_external_if_changed().await.expect("peek"),
        "inside the full-check window an equal stamp is trusted"
    );

    // The window elapses: the next peek is a full read and adopts it.
    set_test_hooks(&data_dir, vec![TestHook::FullCheckIntervalMs(50)]);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        store.adopt_external_if_changed().await.expect("peek"),
        "the periodic full check adopts what the stamp missed"
    );
    assert_eq!(name_of(&store, &target).await, "Name BBBB");
    clear_test_hooks(&data_dir);
}

/// RC9 under load: on the live-size document, 30 readers keep reading while
/// 30 renames commit one after another — every read and every rename
/// succeeds (the readers never compete for the lock).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_reads_during_write_burst_all_succeed() {
    let dir = temp_dir();
    let (document, refs) = synthetic_load_document();
    let size = write_document_before_open(dir.path(), &document);
    assert!(
        size >= 4_500_000,
        "the fixture is the live document's size (got {size} bytes)"
    );
    let store = open(dir.path());
    let targets: Vec<SessionNameRef> = refs.into_iter().take(30).collect();

    let writing = Arc::new(AtomicBool::new(true));
    let writer = tokio::spawn({
        let store = Arc::clone(&store);
        let targets = targets.clone();
        let writing = Arc::clone(&writing);
        async move {
            let mut results = Vec::new();
            for (i, target) in targets.iter().enumerate() {
                results
                    .push(rename_user(&store, target.clone(), &format!("Burst rename {i}")).await);
            }
            writing.store(false, Ordering::SeqCst);
            results
        }
    });
    let readers: Vec<_> = (0..30)
        .map(|reader| {
            let store = Arc::clone(&store);
            let target = targets[reader].clone();
            let writing = Arc::clone(&writing);
            tokio::spawn(async move {
                let mut outcomes = Vec::new();
                loop {
                    outcomes.push(
                        store
                            .get(vec![target.clone()])
                            .await
                            .map(|updates| updates.len()),
                    );
                    if !writing.load(Ordering::SeqCst) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                outcomes
            })
        })
        .collect();

    let renames = writer.await.expect("the writer task completes");
    let rename_errors: Vec<_> = renames.iter().filter_map(|r| r.as_ref().err()).collect();
    assert!(
        rename_errors.is_empty(),
        "every rename in the burst commits: {rename_errors:?}"
    );
    let mut reads = 0usize;
    for reader in readers {
        for outcome in reader.await.expect("the reader task completes") {
            reads += 1;
            match outcome {
                Ok(found) => assert_eq!(found, 1, "every read resolves its record"),
                Err(error) => panic!("a read failed during the write burst: {error:?}"),
            }
        }
    }
    assert!(
        reads >= 30,
        "every reader read at least once ({reads} reads)"
    );
    for (i, target) in targets.iter().enumerate() {
        assert_eq!(name_of(&store, target).await, format!("Burst rename {i}"));
    }
}
