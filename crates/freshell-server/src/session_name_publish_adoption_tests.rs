//! Real-store commits must publish every newly adopted name, including a
//! previous uncertain commit, exactly once at the final committed version.

use std::path::Path;
use std::sync::Arc;

use freshell_protocol::native_location::{
    NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
};
use tokio::sync::broadcast::{error::TryRecvError, Receiver};

use super::super::*;
use crate::session_name_native::NativeOutcomeFold;

fn open(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open real store")
}

fn pending(id: &str) -> SessionNameRef {
    SessionNameRef::Pending { id: id.into() }
}

async fn ensure(names: &SessionNames, id: &str) -> SessionNameRef {
    names
        .ensure_pending(PendingNameInput {
            handle: id.into(),
            provider: NamedProvider::Claude,
            cwd: Some("/work/naming".into()),
        })
        .await
        .expect("ensure pending record");
    pending(id)
}

async fn rename(
    names: &SessionNames,
    target: &SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    names
        .rename(RenameNameInput {
            target: target.clone(),
            name: name.into(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
}

async fn bind(names: &SessionNames, from: &SessionNameRef, id: &str) -> SessionNameUpdate {
    names
        .bind_pending(BindNameInput {
            pending: from.clone(),
            target: SessionNameRef::Session {
                provider: NamedProvider::Claude,
                session_id: id.into(),
            },
            acquisition: NativeAcquisition {
                location: NativeLocation::Claude {
                    config_root: "/isolated/claude".into(),
                    transcript_path: Some(format!("/isolated/claude/{id}.jsonl")),
                    project_directory_key: None,
                    transcript_cwd: None,
                    effective_project_key_override: None,
                },
                evidence: NativeEvidenceKind::SelectedTranscript,
                persistence: NativePersistence::Verified,
            },
        })
        .await
        .expect("verified bind")
}

fn drain(subscriber: &mut Receiver<SessionNameUpdate>) -> Vec<SessionNameUpdate> {
    let mut updates = Vec::new();
    loop {
        match subscriber.try_recv() {
            Ok(update) => updates.push(update),
            Err(TryRecvError::Empty) => return updates,
            Err(error) => panic!("the subscribed store stays live and never lags: {error}"),
        }
    }
}

fn update_for<'a>(
    updates: &'a [SessionNameUpdate],
    target: &SessionNameRef,
) -> &'a SessionNameUpdate {
    let matching: Vec<_> = updates
        .iter()
        .filter(|update| &update.record.name_ref == target)
        .collect();
    assert_eq!(matching.len(), 1, "one final frame per ref: {updates:#?}");
    matching[0]
}

#[tokio::test]
async fn a_write_publishes_another_stores_rename_and_its_own_change_once() {
    let home = tempfile::tempdir().unwrap();
    let local = open(home.path());
    let remote_target = ensure(&local, "external").await;
    let own_target = ensure(&local, "local").await;
    let remote = open(home.path());
    let mut subscriber = local.subscribe();
    let remote_name = rename(&remote, &remote_target, "Renamed on another server")
        .await
        .unwrap();

    let own_name = rename(&local, &own_target, "Renamed here").await.unwrap();

    let updates = drain(&mut subscriber);
    assert_eq!(updates.len(), 2, "both committed changes reach this client");
    let adopted = update_for(&updates, &remote_target);
    assert_eq!(adopted.record, remote_name.record);
    assert!(adopted.changed);
    assert_eq!(update_for(&updates, &own_target).record, own_name.record);
    assert!(updates
        .iter()
        .all(|update| update.document_generation == own_name.document_generation));
    assert!(!local.adopt_external_if_changed().await.unwrap());
    assert!(
        drain(&mut subscriber).is_empty(),
        "the tick never duplicates it"
    );
}

#[tokio::test]
async fn a_write_publishes_its_previous_uncertain_rename_only_after_confirmation() {
    let home = tempfile::tempdir().unwrap();
    let names = open(home.path());
    let uncertain_target = ensure(&names, "uncertain").await;
    let own_target = ensure(&names, "confirmed").await;
    let mut subscriber = names.subscribe();
    set_test_hooks(home.path(), vec![TestHook::PostReplace]);
    let uncertain = rename(&names, &uncertain_target, "Durability confirmed later").await;
    assert!(matches!(uncertain, Err(NameError::CommitUncertain(_))));
    assert!(
        drain(&mut subscriber).is_empty(),
        "uncertainty publishes nothing"
    );
    clear_test_hooks(home.path());

    let confirmed = rename(&names, &own_target, "The confirming write")
        .await
        .unwrap();

    let updates = drain(&mut subscriber);
    assert_eq!(updates.len(), 2);
    assert_eq!(
        update_for(&updates, &uncertain_target).record.name,
        "Durability confirmed later"
    );
    assert!(updates
        .iter()
        .all(|update| update.document_generation == confirmed.document_generation));
    assert!(!names.adopt_external_if_changed().await.unwrap());
    assert!(drain(&mut subscriber).is_empty());
}

#[tokio::test]
async fn an_adopted_name_superseded_by_the_same_write_publishes_only_the_final_winner() {
    let home = tempfile::tempdir().unwrap();
    let local = open(home.path());
    let target = ensure(&local, "same-ref").await;
    let remote = open(home.path());
    let mut subscriber = local.subscribe();
    rename(&remote, &target, "Intermediate remote name")
        .await
        .unwrap();

    let winner = rename(&local, &target, "Final local name").await.unwrap();

    let updates = drain(&mut subscriber);
    assert_eq!(
        updates.len(),
        1,
        "a client never receives the intermediate name"
    );
    assert_eq!(updates[0].record, winner.record);
    assert!(updates[0].changed);
}

#[tokio::test]
async fn an_adopted_native_status_keeps_its_status_only_projection() {
    let home = tempfile::tempdir().unwrap();
    let local = open(home.path());
    let pending_target = ensure(&local, "native").await;
    let target = bind(&local, &pending_target, "native-session")
        .await
        .record
        .name_ref;
    let before = rename(&local, &target, "Native display name")
        .await
        .unwrap();
    let own_target = ensure(&local, "other").await;
    let remote = open(home.path());
    let mut subscriber = local.subscribe();
    let claim = remote
        .claim_native_cycle(target.clone(), "remote-native-receipt".into())
        .await
        .unwrap()
        .expect("manual name has an armed native series");
    let synced = remote
        .fold_native_outcome(
            target.clone(),
            claim.location_revision,
            claim.series_epoch,
            NativeOutcomeFold::Read {
                observed: Some(before.record.name.clone()),
                receipt: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(synced.record, before.record);
    assert_eq!(
        synced.native_sync.as_ref().unwrap().status,
        freshell_protocol::session_names::NativeSyncStatus::Synced
    );

    rename(&local, &own_target, "Unrelated name").await.unwrap();

    let updates = drain(&mut subscriber);
    assert_eq!(updates.len(), 2);
    let adopted = update_for(&updates, &target);
    assert_eq!(adopted.record, before.record);
    assert_eq!(adopted.native_sync, synced.native_sync);
    assert!(
        !adopted.changed,
        "native status never claims a new saved name"
    );
    assert_eq!(adopted.redirects, synced.redirects);
}

#[tokio::test]
async fn an_adopted_bind_keeps_its_redirect_in_the_final_committed_frame() {
    let home = tempfile::tempdir().unwrap();
    let local = open(home.path());
    let source = ensure(&local, "redirected").await;
    let own_target = ensure(&local, "unrelated").await;
    let remote = open(home.path());
    let mut subscriber = local.subscribe();
    let bound = bind(&remote, &source, "adopted-session").await;

    rename(&local, &own_target, "Own write").await.unwrap();

    let updates = drain(&mut subscriber);
    assert_eq!(updates.len(), 2);
    let adopted = update_for(&updates, &bound.record.name_ref);
    assert_eq!(adopted.record, bound.record);
    assert_eq!(adopted.redirects, bound.redirects);
    assert_eq!(adopted.redirects[0].from, source);
    assert!(adopted.changed);
}

#[tokio::test]
async fn a_failed_write_publishes_neither_adopted_nor_uncommitted_changes() {
    let home = tempfile::tempdir().unwrap();
    let local = open(home.path());
    let remote_target = ensure(&local, "external-before-failure").await;
    let own_target = ensure(&local, "failed-local").await;
    let remote = open(home.path());
    let mut subscriber = local.subscribe();
    let remote_name = rename(&remote, &remote_target, "Remote accepted name")
        .await
        .unwrap();
    set_test_hooks(home.path(), vec![TestHook::PreReplace]);

    let failed = rename(&local, &own_target, "Never accepted").await;

    assert!(matches!(failed, Err(NameError::Persistence(_))));
    assert!(
        drain(&mut subscriber).is_empty(),
        "failure publishes nothing"
    );
    clear_test_hooks(home.path());
    assert!(local.adopt_external_if_changed().await.unwrap());
    let updates = drain(&mut subscriber);
    assert_eq!(
        updates.len(),
        1,
        "the later adoption only publishes the remote commit"
    );
    assert_eq!(updates[0].record, remote_name.record);
}
