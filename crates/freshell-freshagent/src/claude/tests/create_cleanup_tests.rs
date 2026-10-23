use super::*;

#[tokio::test]
async fn create_cleanup_authority_belongs_to_the_established_runtime_and_is_retained_on_replay() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeClaudeSidecarEnv::install();
    let (st, mut rx) = state_with_bus();
    let mut original_request = dedup_create_msg("create-cleanup-authority");
    original_request.tab_id = Some("cleanup-tab".into());
    original_request.pane_id = Some("cleanup-pane".into());
    let first = st.handle_create(original_request.clone(), None).await;
    let ClaudeCreateOutcome::Created {
        session_id,
        cleanup_ownership_id: Some(original_owner),
        ..
    } = first
    else {
        panic!("a newly established runtime must carry cleanup authority: {first:?}");
    };
    assert_eq!(
        st.sessions.lock().await[&session_id].ownership_id,
        original_owner
    );
    let wire = await_claude_created(&mut rx, "create-cleanup-authority").await;
    assert!(
        wire.get("cleanupOwnershipId").is_none(),
        "the cleanup receipt is Rust-only"
    );

    // A later runtime now occupies the same durable session id. Replaying the
    // old request retains the old receipt; it cannot mint authority over this one.
    let removed = st.sessions.lock().await.remove(&session_id).unwrap();
    st.teardown_removed_session_logged(removed).await;
    insert_fake_claude_session(&st, &session_id).await;
    assert_ne!(
        st.sessions.lock().await[&session_id].ownership_id,
        original_owner
    );
    let replay = st.handle_create(original_request.clone(), None).await;
    assert!(
        matches!(replay, ClaudeCreateOutcome::Created { cleanup_ownership_id: Some(owner), .. }
        if owner == original_owner)
    );

    for destination in [None, Some("another-pane")] {
        let mut different = original_request.clone();
        different.pane_id = destination.map(str::to_string);
        let replay = st.handle_create(different, None).await;
        assert!(matches!(replay, ClaudeCreateOutcome::Created { cleanup_ownership_id: None, .. }),
            "an absent or different destination cannot inherit earlier cleanup authority: {replay:?}");
    }

    let mut adopting = dedup_create_msg("adopt-without-cleanup-authority");
    adopting.session_ref = Some(claude_session_ref(&session_id));
    for _ in 0..2 {
        let adopted = st.handle_create(adopting.clone(), None).await;
        assert!(
            matches!(
                adopted,
                ClaudeCreateOutcome::Created {
                    cleanup_ownership_id: None,
                    ..
                }
            ),
            "adopting or replaying adoption must not authorize process cleanup: {adopted:?}"
        );
    }
    st.shutdown().await;
}
