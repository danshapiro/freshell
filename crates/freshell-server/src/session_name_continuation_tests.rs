//! Real-store admission and explicit internal-continuation behavior.

use super::*;

fn session(id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Claude,
        session_id: id.into(),
    }
}

#[tokio::test]
async fn known_session_admission_is_idempotent_and_rename_keeps_revision_guards() {
    let home = tempfile::tempdir().unwrap();
    let names = SessionNames::open(home.path().to_path_buf()).unwrap();
    let first = names
        .ensure_session(session("switched"), Some("/work/billing".into()))
        .await
        .unwrap();
    assert_eq!(first.record.name, "billing");
    assert_eq!(first.record.source, NameSource::Directory);
    let renamed = names
        .rename(RenameNameInput {
            target: session("switched"),
            name: "Invoices".into(),
            intent: NameIntent::User,
            if_revision: Some(first.record.revision),
            cwd: None,
        })
        .await
        .unwrap();
    let again = names
        .ensure_session(session("switched"), Some("/other".into()))
        .await
        .unwrap();
    assert_eq!(again.record, renamed.record);
    assert!(matches!(
        names
            .rename(RenameNameInput {
                target: session("switched"),
                name: "Stale".into(),
                intent: NameIntent::User,
                if_revision: Some(first.record.revision),
                cwd: None,
            })
            .await,
        Err(NameError::Conflict { .. })
    ));
}

#[tokio::test]
async fn internal_continuation_preserves_manual_name_once_without_aliasing_sessions() {
    let home = tempfile::tempdir().unwrap();
    let names = SessionNames::open(home.path().to_path_buf()).unwrap();
    names
        .ensure_pending(PendingNameInput {
            handle: "source".into(),
            provider: NamedProvider::Claude,
            cwd: None,
        })
        .await
        .unwrap();
    let pending = SessionNameRef::Pending {
        id: "source".into(),
    };
    let original = names
        .rename(RenameNameInput {
            target: pending.clone(),
            name: "Keep this name".into(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
        .unwrap();
    let child = names
        .continue_session(pending.clone(), session("child"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(child.record.name, original.record.name);
    assert_eq!(child.record.source, NameSource::Manual);
    assert_eq!(
        child.record.manual_revision,
        original.record.manual_revision
    );
    assert_eq!(child.record.renamed_at, original.record.renamed_at);
    assert_eq!(child.record.name_ref, session("child"));
    assert!(child.redirects.is_empty());
    names
        .rename(RenameNameInput {
            target: pending.clone(),
            name: "Changed source".into(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
        .unwrap();
    let again = names
        .continue_session(pending, session("child"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        again.record, child.record,
        "repeated continuation must not replace a child's independent name"
    );
    let reopened = SessionNames::open(home.path().to_path_buf()).unwrap();
    assert_eq!(
        reopened.get(vec![session("child")]).await.unwrap()[0].record,
        child.record
    );
}

#[tokio::test]
async fn an_unnamed_continuation_does_not_invent_or_copy_a_name() {
    let home = tempfile::tempdir().unwrap();
    let names = SessionNames::open(home.path().to_path_buf()).unwrap();
    assert!(names
        .continue_session(session("unknown"), session("child"))
        .await
        .unwrap()
        .is_none());
    assert!(names.get(vec![session("child")]).await.unwrap().is_empty());
}

#[tokio::test]
async fn continuation_cannot_inherit_an_inflight_request_that_only_belongs_to_its_source() {
    let home = tempfile::tempdir().unwrap();
    let names = SessionNames::open(home.path().to_path_buf()).unwrap();
    names.ensure_session(session("source"), None).await.unwrap();
    names
        .activity(NameActivity {
            target: session("source"),
            mode: "freshclaude".into(),
            event_id: "first".into(),
            reason: NameActivityReason::AcceptedUserMessage,
            first_user_message: Some("Explore the cache layer".into()),
            cwd: None,
        })
        .await
        .unwrap();
    names
        .claim_generation_start(session("source"), "inflight-attempt".into())
        .await
        .unwrap()
        .unwrap();
    names
        .continue_session(session("source"), session("child"))
        .await
        .unwrap()
        .unwrap();
    let view = names.core.current_view();
    let source = &view.document.generation[&name_ref_key(&session("source"))];
    let child = &view.document.generation[&name_ref_key(&session("child"))];
    assert_eq!(
        source.status,
        GenerationStatus::InFlight,
        "the source's request is still live"
    );
    assert_eq!(
        child.status,
        GenerationStatus::Eligible,
        "the child's series must remain retryable without a server restart"
    );
    assert_eq!(child.consumed, source.consumed);
    assert_eq!(child.excerpt, source.excerpt);
}
