//! A commit whose durable replace ends uncertain (the replacement landed,
//! its durability is unproven: `NameError::CommitUncertain`) logs nothing
//! when it is made. The next transaction reconciles durability and adopts
//! or commits over that document; it then logs the change once, with its
//! own cause — never as another process's change (`adopted_external`).
//!
//! A child of the events tests (that file is over the 1000-line cap); it
//! uses their fixtures and the same process-wide trace capture.

use super::*;

async fn current(names: &SessionNames, target: &SessionNameRef) -> SessionNameUpdate {
    names
        .get(vec![target.clone()])
        .await
        .expect("get")
        .into_iter()
        .next()
        .expect("the record exists")
}

/// The next transaction is a read: the adoption logs the store's own rename
/// as `manual_rename`, once.
#[tokio::test]
async fn an_uncertain_commit_logs_its_own_cause_once_a_read_confirms_it() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = pending("evt-uncertain-read");
    let created = ensure(&names, "evt-uncertain-read", "/w/evt-uncertain-read").await;
    set_test_hooks(dir.path(), vec![TestHook::PostReplace]);
    let since = mark();

    let uncertain = rename(&names, &target, "Release plan", NameIntent::User).await;

    assert!(
        matches!(uncertain, Err(NameError::CommitUncertain(_))),
        "{uncertain:?}"
    );
    assert_no_change(since, &target, "an unconfirmed commit is not logged yet");

    clear_test_hooks(dir.path());
    names
        .refresh_current()
        .await
        .expect("the next transaction confirms the document");
    let confirmed = current(&names, &target).await;
    assert_eq!(confirmed.record.name, "Release plan");
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "manual_rename".into(),
            old: old_of(&created),
            new: new_of(&confirmed),
            self_heal: false,
            extra: no_extra(),
        }
    );

    // Confirmed once: later transactions never log it again.
    let again = mark();
    names.refresh_current().await.unwrap();
    rename(
        &names,
        &pending("evt-uncertain-read"),
        "Release plan",
        NameIntent::User,
    )
    .await
    .unwrap();
    assert_no_change(again, &target, "the change was already logged");
}

/// The next transaction is a commit, and another process committed on top
/// of the uncertain document first: the store's own bind keeps its cause
/// and its `from_ref`, the other process's rename is `adopted_external`,
/// and the new commit logs its own change — each exactly once.
#[tokio::test]
async fn an_uncertain_commit_keeps_its_cause_when_a_commit_lands_over_it() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let mine = claude("evt-uncertain-mine");
    ensure(&names, "evt-uncertain-mine-h", "/w/evt-uncertain-mine").await;
    let theirs = claude("evt-uncertain-theirs");
    let theirs_before = hydrate(&names, "evt-uncertain-theirs", None, None).await;
    set_test_hooks(dir.path(), vec![TestHook::PostReplace]);
    let since_uncertain = mark();

    let uncertain = names
        .bind_pending(BindNameInput {
            pending: pending("evt-uncertain-mine-h"),
            target: mine.clone(),
            acquisition: verified_claude(),
        })
        .await;

    assert!(
        matches!(uncertain, Err(NameError::CommitUncertain(_))),
        "{uncertain:?}"
    );
    assert_no_change(since_uncertain, &mine, "an unconfirmed bind is not logged");

    // Another process reconciles and adopts the document at open (which logs
    // nothing), then commits its own rename on top of it.
    clear_test_hooks(dir.path());
    let other = open_store(dir.path());
    let theirs_renamed = rename(&other, &theirs, "Renamed elsewhere", NameIntent::User)
        .await
        .unwrap();
    assert_no_change(since_uncertain, &mine, "the other process never logs it");
    let since = mark();

    // This store's next commit lands over both documents.
    let next = pending("evt-uncertain-next");
    let created = ensure(&names, "evt-uncertain-next", "/w/evt-uncertain-next").await;

    let bound = current(&names, &mine).await;
    assert_eq!(
        one_change(since, &mine),
        NameChanged {
            cause: "bind".into(),
            old: None,
            new: new_of(&bound),
            self_heal: false,
            extra: extra(&[("from_ref", &name_ref_key(&pending("evt-uncertain-mine-h")))]),
        }
    );
    assert_eq!(
        one_change(since, &theirs),
        NameChanged {
            cause: "adopted_external".into(),
            old: old_of(&theirs_before),
            new: new_of(&theirs_renamed),
            self_heal: false,
            extra: no_extra(),
        }
    );
    assert_eq!(
        one_change(since, &next),
        NameChanged {
            cause: "ensure_pending".into(),
            old: None,
            new: new_of(&created),
            self_heal: false,
            extra: no_extra(),
        }
    );
}
