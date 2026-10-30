//! A long Undo marker history must not fill the native reader's request pipe.
use super::*;
use crate::identity_sink::PaneIdentitySink;
use sha2::{Digest, Sha256};

struct RestoreEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl Drop for RestoreEnvironment {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn accumulated_large_rollback_markers_keep_worker_snapshot_undo_and_redo_usable() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let _restore = RestoreEnvironment(
        [
            "HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_PROVIDER_RUN_AS_UID",
            "FRESHELL_PROVIDER_RUN_AS_GID",
        ]
        .into_iter()
        .map(|key| (key, std::env::var_os(key)))
        .collect(),
    );
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join(".claude");
    std::env::set_var("HOME", home.path());
    std::env::set_var("CLAUDE_CONFIG_DIR", &config);
    std::env::remove_var("FRESHELL_PROVIDER_RUN_AS_UID");
    std::env::remove_var("FRESHELL_PROVIDER_RUN_AS_GID");
    if std::env::var_os("FRESHELL_TEST_CLAUDE_HISTORY_WORKER").is_some() {
        assert_ne!(
            unsafe { libc::geteuid() },
            0,
            "the real worker must run as the sandbox provider UID"
        );
    }

    let original = uuid::Uuid::new_v4().to_string();
    let current = uuid::Uuid::new_v4().to_string();
    let ids: Vec<_> = (0..20).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    let rows: Vec<Value> = (0..20).map(|index| json!({
        "type":if index % 2 == 0 {"user"} else {"assistant"},
        "uuid":ids[index], "parentUuid":index.checked_sub(1).map(|prior|ids[prior].as_str()),
        "sessionId":original, "cwd":"/tmp",
        "message":{"role":if index % 2 == 0 {"user"} else {"assistant"},
            "content":[{"type":"text","text":format!("native {} {}", if index % 2 == 0 {"input"} else {"answer"},index/2)}]},
    })).collect();
    let original_text = rows
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    let current_text = rows[..10]
        .iter()
        .map(|row| {
            let mut row = row.clone();
            row["sessionId"] = json!(current);
            format!("{row}\n")
        })
        .collect::<String>();
    write_rollback_transcript(&config, &original, &original_text);
    write_rollback_transcript(&config, &current, &current_text);
    let original_path = config.join("projects/-t").join(format!("{original}.jsonl"));
    let current_path = config.join("projects/-t").join(format!("{current}.jsonl"));
    let original_before = std::fs::read(&original_path).unwrap();
    let current_before = std::fs::read(&current_path).unwrap();

    let mut record = RollbackRecord::empty(200);
    record.current_epoch = 1;
    record.can_redo = true;
    record.original_session_id = Some(original.clone());
    record.original_tip_uuid = Some(ids[19].clone());
    let body = "x".repeat(2 * 1024 * 1024);
    let mut redoable = Vec::new();
    for index in 0..9 {
        let (user, assistant, epoch) = if index < 4 {
            (
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
                0,
            )
        } else {
            let pair = index + 1;
            redoable.push(ids[pair * 2].clone());
            (ids[pair * 2].clone(), ids[pair * 2 + 1].clone(), 1)
        };
        record.entries.push(RollbackEntry {
            removed_turns:vec![
                json!({"id":user,"turnId":user,"role":"user","summary":"saved prompt","items":[{"id":format!("{user}-text"),"kind":"text","text":body}]}),
                json!({"id":assistant,"turnId":assistant,"role":"assistant","summary":"saved answer","items":[{"id":format!("{assistant}-text"),"kind":"text","text":body}]}),
            ],
            prompt_text:body.clone(), at_ms:200 + index as i64, epoch,
        });
    }
    let saved_before = serde_json::to_vec(&record).unwrap();
    assert!(saved_before.len() as u64 > MANAGED_HISTORY_BYTES);
    let saved_digest = Sha256::digest(&saved_before);
    let (state, _) = state_with_bus();
    let state = state.with_managed_forks();
    let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
    sink.record_rollback("claude", &current, record.clone())
        .await
        .unwrap();
    state.set_identity_sink(sink.clone());
    *state.managed_prefix.lock().await = Some(freshell_agent_runtime::ClaudeForkRecipe {
        recovery_disabled: false,
        child_session_id: current.clone(),
        parent_session_id: original.clone(),
        parent_transcript: format!(".claude/projects/-t/{original}.jsonl"),
        child_transcript: format!(".claude/projects/-t/{current}.jsonl"),
        parent_sha256: format!("{:x}", Sha256::digest(&original_before)),
        target: freshell_agent_runtime::ClaudeForkTarget::Prefix {
            cutoff_uuid: ids[9].clone(),
            drop_turn_uuid: None,
        },
    });

    let mut snapshot_request = state.managed_history_request("snapshot", &current).await;
    snapshot_request["sessionType"] = json!("freshclaude");
    snapshot_request["rollback"] = json!(record);
    let native_snapshot = state.read_managed_history(snapshot_request).await
        .expect("the actual provider-UID worker must accept a request despite more than 32MiB of saved marker bodies");
    assert_eq!(native_snapshot["latestTurnId"], ids[9]);
    let snapshot = state
        .get_snapshot(SessionType::Freshclaude, &current)
        .await
        .expect("a large saved marker bucket must not block the actual native reader");
    assert_eq!(snapshot["latestTurnId"], ids[9]);
    assert_eq!(
        snapshot["turns"].as_array().unwrap().last().unwrap()["items"][0]["text"],
        "native answer 4"
    );
    assert_eq!(snapshot["capabilities"]["send"], true);
    assert_eq!(snapshot["rollback"]["canRedo"], true);
    assert_eq!(
        snapshot["rollback"]["undoneDepth"], 9,
        "old epochs and every marker remain counted once"
    );
    assert_eq!(snapshot["rollback"]["redoableTurnIds"], json!(redoable));
    assert!(
        serde_json::to_vec(&snapshot).unwrap().len()
            < crate::native_history::MAX_HISTORY_BYTES as usize
    );

    for (redo, expected_anchor, expected_prompt) in [
        (false, &ids[7], "native input 4"),
        (true, &ids[11], "native input 5"),
    ] {
        let mut request = state.managed_history_request("rollback", &current).await;
        request["rollback"] = json!(record);
        request["redo"] = json!(redo);
        let copied = managed_history::worker_request(request.clone());
        assert!(
            serde_json::to_vec(&copied).unwrap().len() < MANAGED_HISTORY_BYTES as usize,
            "all copied marker display bodies together must stay out of the worker request"
        );
        let resolution = state.read_managed_history(request).await.unwrap();
        assert_eq!(
            resolution["Ok"]["resume_at_uuid"],
            json!(expected_anchor),
            "{resolution}"
        );
        assert_eq!(
            resolution["Ok"]["prompt_text"], expected_prompt,
            "native text, not a copied marker preview, refills the composer"
        );
    }
    assert_eq!(std::fs::read(&original_path).unwrap(), original_before);
    assert_eq!(std::fs::read(&current_path).unwrap(), current_before);
    let saved_after = sink.load_rollback("claude", &current).unwrap();
    assert_eq!(
        Sha256::digest(serde_json::to_vec(&saved_after).unwrap()),
        saved_digest,
        "every saved marker body, role, ID, epoch and anchor remains unchanged"
    );

    // A later native write invalidates Redo even though the saved bit is true.
    let mut changed = original_before.clone();
    changed.extend(
        format!(
            "{}\n",
            json!({"type":"assistant","uuid":uuid::Uuid::new_v4().to_string(),"sessionId":original})
        )
        .as_bytes(),
    );
    std::fs::write(&original_path, changed).unwrap();
    let snapshot = state
        .get_snapshot(SessionType::Freshclaude, &current)
        .await
        .unwrap();
    assert_eq!(snapshot["rollback"]["canRedo"], false);
    assert_eq!(snapshot["rollback"]["redoableTurnIds"], json!([]));
}
