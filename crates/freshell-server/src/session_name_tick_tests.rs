//! The 2 s naming tick, driven for real on a temp naming home: while the
//! document is unchanged it costs a stat (no store transaction), and a
//! second process's commit reaches this process's subscribers through it.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use freshell_freshagent::naming::{PendingNameInput, RenameNameInput, SessionNaming};
use freshell_protocol::session_names::{NameIntent, NamedProvider, SessionNameRef};

use super::*;
use crate::session_names::test_store_transaction_count;

fn open(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open store")
}

async fn rename(store: &Arc<SessionNames>, target: &SessionNameRef, name: &str) {
    store
        .rename(RenameNameInput {
            target: target.clone(),
            name: name.to_string(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
        .expect("rename");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_tick_reads_nothing_while_unchanged_and_adopts_another_process_commit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    let target = SessionNameRef::Pending {
        id: "h-tick".to_string(),
    };
    store
        .ensure_pending(PendingNameInput {
            handle: "h-tick".to_string(),
            provider: NamedProvider::Claude,
            cwd: Some("/w/tick".to_string()),
        })
        .await
        .expect("ensure pending");
    rename(&store, &target, "Named here").await;
    let mut updates = store.subscribe();

    let before = test_store_transaction_count(dir.path());
    let tick = tokio::spawn(run_naming_tick(
        Arc::clone(&store),
        TerminalIdentityRegistry::new(),
        TerminalRegistry::new(),
        Duration::from_millis(20),
    ));
    // About a dozen ticks over an unchanged document.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        test_store_transaction_count(dir.path()),
        before,
        "ticks over an unchanged document took no store transaction (no lock, no parse)"
    );

    // Another process commits; nothing in this process reads the name, so
    // only the tick can carry the commit to this process's subscribers.
    let other = open(dir.path());
    rename(&other, &target, "Named elsewhere").await;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let update = tokio::time::timeout(remaining, updates.recv())
            .await
            .expect("the tick adopted the other process's commit within 5 s")
            .expect("the update channel stays open");
        if update.record.name == "Named elsewhere" {
            break;
        }
    }
    tick.abort();
}
