use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canceling_recovery_stop_keeps_cleanup_running_and_releases_the_unwired_lease() {
    let (st, _rx) = state_with_bus();
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&st, &id).await;
    let (pid, owner, turn_lock) = {
        let sessions = st.sessions.lock().await;
        let session = &sessions[&id];
        (
            session.child.id().unwrap(),
            session.ownership_id.clone(),
            session.turn_lock.clone(),
        )
    };
    let LaunchLease::Acquired(mut lease) = st.claim_launch_lease(&id, "recovery-stop-create").await
    else {
        panic!("the test runtime must acquire its provider lease");
    };
    lease.set_kill_handle(pid, &owner);
    assert!(lease.complete(&id));
    // A blocked configure/send may own this lock while its RPC never answers.
    // Recovery must stop the process without waiting behind that control.
    let turn = turn_lock.lock().await;
    let request = {
        let st = st.clone();
        let id = id.clone();
        tokio::spawn(async move {
            st.handle_recovery_stop(freshell_protocol::FreshAgentRecoveryStop {
                request_id: "cancelable-recovery-stop".into(),
                provider: freshell_protocol::AgentProvider::Claude,
                session_id: id,
                session_type: SessionType::Freshclaude,
                observed_epoch: None,
                observed_generation: None,
            })
            .await;
        })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while st.resolve_session_key(&id).await.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("recovery waited behind an unresolved turn control");
    assert!(
        !request.is_finished(),
        "the sleeper keeps cleanup pending during graceful shutdown"
    );
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let LaunchLease::Acquired(mut next) =
                st.claim_launch_lease(&id, "after-canceled-recovery").await
            {
                next.fail();
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("canceling the requester abandoned cleanup and stranded its completed lease");
    assert!(st.dead_sessions.find(&id).is_some());
    assert!(!st.condemned_priors.lock().unwrap().contains_key(&id));
    drop(turn);
    st.shutdown().await;
}
