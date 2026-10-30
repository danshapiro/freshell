//! Provider-UID history operations used by managed native recovery.
use super::*;
use std::process::Stdio;

pub(super) const MANAGED_HISTORY_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MANAGED_HISTORY_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct ClaudeRollbackTranscript {
    pub(super) path: PathBuf,
    pub(super) source_session_id: String,
    pub(super) content: String,
    pub(super) cwd: Option<String>,
    pub(super) modified_ms: Option<i64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct ClaudeRollbackSource {
    pub(super) path: PathBuf,
    pub(super) cwd: Option<String>,
    pub(super) sha256: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct ClaudeRollbackResolution {
    pub(super) resume_from: String,
    pub(super) resume_at_uuid: Option<String>,
    pub(super) removed_turns: Vec<Value>,
    pub(super) prompt_text: String,
    pub(super) chain_root: String,
    pub(super) original_tip_uuid: Option<String>,
    pub(super) can_redo_after: bool,
    pub(super) guard_uuid: Option<String>,
    pub(super) source_path: PathBuf,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct ClaudeForkResolution {
    pub(super) source_session_id: String,
    pub(super) source_path: PathBuf,
    pub(super) at: String,
}

pub(super) type ClaudeRollbackFailure = (String, String);

fn locate_history_path(session_id: &str) -> Result<Option<PathBuf>, String> {
    match crate::claude_snapshot::locate_transcript_state(session_id) {
        crate::claude_snapshot::TranscriptLocation::Found(path) => Ok(Some(path)),
        crate::claude_snapshot::TranscriptLocation::Absent => Ok(None),
        crate::claude_snapshot::TranscriptLocation::Unreadable(error) => Err(error.to_string()),
    }
}

// Native chain operations stay next to the transcript. Only their anchors and
// retained display results cross the existing provider-UID worker boundary.
pub(super) fn read_claude_operation_transcript(
    request: &Value,
) -> Result<Option<ClaudeRollbackTranscript>, String> {
    let session_id = request["sessionId"]
        .as_str()
        .ok_or("invalid Claude history identity")?;
    let transcript =
        read_claude_transcript_local(session_id, request["allowRemoved"] == true, false)?;
    if transcript.is_some() {
        return Ok(transcript);
    }
    if request["fork"].is_null() {
        let Some(raw) = request.get("genesis").filter(|value| !value.is_null()) else {
            return Ok(None);
        };
        let genesis: crate::claude_launch::ClaudeGenesis =
            serde_json::from_value(raw["genesis"].clone()).map_err(|_| "invalid Claude genesis")?;
        return match genesis {
            crate::claude_launch::ClaudeGenesis::Fresh => Ok(Some(ClaudeRollbackTranscript {
                path: PathBuf::new(),
                source_session_id: session_id.to_owned(),
                content: String::new(),
                cwd: None,
                modified_ms: None,
            })),
            crate::claude_launch::ClaudeGenesis::Fork { parent, at, .. } => {
                let mut source = read_claude_transcript_local(&parent, false, false)?
                    .ok_or("Claude fork parent missing")?;
                source.content =
                    crate::claude_snapshot::fork_prefix_transcript(&source.content, at.as_deref())
                        .ok_or("Claude fork point missing")?;
                Ok(Some(source))
            }
        };
    }
    let recipe: freshell_agent_runtime::ClaudeForkRecipe =
        serde_json::from_value(request["fork"].clone())
            .map_err(|_| "invalid Claude fork recipe")?;
    recipe.validate(session_id)?;
    let home = std::env::var("HOME").map_err(|_| "managed provider HOME unavailable")?;
    let parent = freshell_agent_runtime::read_verified_claude_fork_parent(
        std::path::Path::new(&home),
        &recipe,
    )?;
    let path = PathBuf::from(home).join(&recipe.parent_transcript);
    let cwd = crate::claude_snapshot::transcript_cwd(&path)
        .filter(|cwd| std::path::Path::new(cwd).is_dir());
    let modified_ms = std::fs::metadata(&path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64);
    let cutoff = match &recipe.target {
        freshell_agent_runtime::ClaudeForkTarget::Prefix { cutoff_uuid, .. } => {
            Some(cutoff_uuid.as_str())
        }
        freshell_agent_runtime::ClaudeForkTarget::Empty => None,
    };
    Ok(Some(ClaudeRollbackTranscript {
        path,
        source_session_id: recipe.parent_session_id,
        cwd,
        modified_ms,
        content: crate::claude_snapshot::fork_prefix(&parent, cutoff)?,
    }))
}

pub(super) fn read_claude_rollback_source(
    request: &Value,
) -> Result<Option<ClaudeRollbackSource>, String> {
    use sha2::Digest;
    use std::io::Read;
    let session_id = request["sessionId"]
        .as_str()
        .ok_or("invalid Claude history identity")?;
    let path = if let Some(path) = locate_history_path(session_id)? {
        path
    } else if !request["fork"].is_null() {
        let recipe: freshell_agent_runtime::ClaudeForkRecipe =
            serde_json::from_value(request["fork"].clone())
                .map_err(|_| "invalid Claude fork recipe")?;
        let home = std::env::var("HOME").map_err(|_| "managed provider HOME unavailable")?;
        freshell_agent_runtime::read_verified_claude_fork_parent(
            std::path::Path::new(&home),
            &recipe,
        )?;
        PathBuf::from(home).join(&recipe.parent_transcript)
    } else {
        return Ok(None);
    };
    let file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    let mut reader = (&file).take(before.len().saturating_add(1));
    let mut hash = sha2::Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut bytes = 0;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|error| error.to_string())?;
    let current = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if !before.is_file()
        || bytes != before.len()
        || after.len() != before.len()
        || before.modified().ok() != after.modified().ok()
        || current.len() != after.len()
        || current.modified().ok() != after.modified().ok()
    {
        return Err("Claude fork source changed during read".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != current.dev() || before.ino() != current.ino() {
            return Err("Claude fork source changed during read".into());
        }
    }
    let cwd = crate::claude_snapshot::transcript_cwd(&path)
        .filter(|cwd| std::path::Path::new(cwd).is_dir());
    Ok(Some(ClaudeRollbackSource {
        path,
        cwd,
        sha256: format!("{:x}", hash.finalize()),
    }))
}

pub(super) fn resolve_claude_rollback(
    request: &Value,
) -> Result<ClaudeRollbackResolution, ClaudeRollbackFailure> {
    use crate::claude_snapshot as snap;
    use crate::rollback_record::*;
    let failure = |code: &str, message: &str| (code.to_owned(), message.to_owned());
    let session_id = request["sessionId"]
        .as_str()
        .ok_or_else(|| failure("INTERNAL_ERROR", "invalid Claude history identity"))?;
    let record: Option<RollbackRecord> = serde_json::from_value(request["rollback"].clone())
        .map_err(|_| failure("INTERNAL_ERROR", "invalid Claude rollback record"))?;
    let read = |read_request: &Value| {
        read_claude_operation_transcript(read_request)
            .map_err(|message| failure("INTERNAL_ERROR", &message))
    };
    let to_turn = request["toTurn"].as_str();
    let mut resolution = if request["redo"] != true {
        let current =
            read(request)?.ok_or_else(|| failure("NOTHING_TO_UNDO", UNDO_EMPTY_MESSAGE))?;
        let target = to_turn.map_or(snap::ResumeTarget::Step, |id| {
            snap::ResumeTarget::ToTurn(id.to_owned())
        });
        let point =
            snap::resolve_resume_point(&current.content, session_id, target).map_err(|error| {
                match error {
                    snap::ResumeResolveError::Empty => {
                        failure("NOTHING_TO_UNDO", UNDO_EMPTY_MESSAGE)
                    }
                    _ => failure(
                        "INVALID_ROLLBACK_TARGET",
                        &format!("turn {:?} is not in this conversation", to_turn),
                    ),
                }
            })?;
        let chain_root = record
            .as_ref()
            .filter(|record| !record.redo_destroyed)
            .and_then(|record| record.original_session_id.clone())
            .unwrap_or_else(|| session_id.to_owned());
        let original_tip_uuid = if chain_root == session_id {
            snap::raw_chain_tip(&current.content)
        } else {
            let root = read(&json!({"sessionId":chain_root}))?
                .ok_or_else(|| failure("INTERNAL_ERROR", "chain-root transcript unreadable"))?;
            snap::raw_chain_tip(&root.content)
        };
        let source_text = if current.source_session_id == session_id {
            current.content.clone()
        } else {
            read(&json!({"sessionId":current.source_session_id}))?
                .ok_or_else(|| failure("INTERNAL_ERROR", "fork source missing"))?
                .content
        };
        let guard_uuid = point
            .resume_at_uuid
            .as_deref()
            .and_then(|at| snap::drops_turn_guard(&source_text, Some(at)));
        ClaudeRollbackResolution {
            resume_from: current.source_session_id,
            resume_at_uuid: point.resume_at_uuid,
            removed_turns: point.removed_turns,
            prompt_text: point.prompt_text,
            chain_root,
            original_tip_uuid,
            can_redo_after: true,
            guard_uuid,
            source_path: current.path,
        }
    } else {
        let record = record.ok_or_else(|| failure("REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE))?;
        if record.redo_destroyed {
            return Err(failure("REDO_UNAVAILABLE", REDO_DESTROYED_MESSAGE));
        }
        let original_id = record
            .original_session_id
            .as_deref()
            .ok_or_else(|| failure("REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE))?;
        let original = read(&json!({"sessionId":original_id}))?
            .ok_or_else(|| failure("REDO_UNAVAILABLE", REDO_REMOVED_HISTORY_COPY))?;
        let current = read(request)?
            .ok_or_else(|| failure("INTERNAL_ERROR", "current transcript missing"))?;
        let original_tip = snap::raw_chain_tip(&original.content);
        if original_tip != record.original_tip_uuid
            || snap::raw_lcp_end(&current.content, &original.content)
                != snap::raw_chain_tip(&current.content)
        {
            return Err(failure("REDO_UNAVAILABLE", REDO_REMOVED_HISTORY_COPY));
        }
        let op = RollbackRequest {
            direction: RollbackDirection::Redo,
            mode: if to_turn.is_some() {
                RollbackModeReq::ToTurn
            } else {
                RollbackModeReq::Step
            },
            turn_id: to_turn.map(str::to_owned),
            session_id: session_id.to_owned(),
            session_type: SessionType::Freshclaude,
            provider: freshell_protocol::AgentProvider::Claude,
            request_id: String::new(),
            cwd: None,
            observed_epoch: None,
            observed_generation: None,
        };
        let resume_at = snap::redo_resume_target(&original.content, &current.content, &op)
            .map_err(|message| failure("INVALID_ROLLBACK_TARGET", &message))?
            .ok_or_else(|| failure("REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE))?;
        let restored = snap::restored_slice_turns(&original.content, &current.content, &resume_at);
        let guard_uuid = snap::drops_turn_guard(&original.content, Some(&resume_at));
        let can_redo_after = original_tip.as_deref() != Some(resume_at.as_str());
        ClaudeRollbackResolution {
            resume_from: original_id.to_owned(),
            resume_at_uuid: Some(resume_at),
            removed_turns: restored.turns,
            prompt_text: restored.prompt_text,
            chain_root: original_id.to_owned(),
            original_tip_uuid: record.original_tip_uuid,
            can_redo_after,
            guard_uuid,
            source_path: original.path,
        }
    };
    let mut display = json!({"turns":std::mem::take(&mut resolution.removed_turns)});
    crate::native_history::retain_snapshot_display("claude", &mut display);
    resolution.removed_turns = display["turns"]
        .as_array_mut()
        .map(std::mem::take)
        .unwrap_or_default();
    Ok(resolution)
}

pub(super) fn read_claude_transcript_local(
    session_id: &str,
    allow_removed: bool,
    bounded: bool,
) -> Result<Option<ClaudeRollbackTranscript>, String> {
    use std::io::Read;
    let Some(path) = locate_history_path(session_id)? else {
        return Ok(None);
    };
    let content = if bounded {
        match std::fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(MANAGED_HISTORY_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| error.to_string())?;
                if bytes.len() as u64 > MANAGED_HISTORY_BYTES {
                    return Err("managed Claude transcript exceeds read budget".into());
                }
                String::from_utf8(bytes).map_err(|_| "Claude transcript is not UTF-8")?
            }
            Err(error) if allow_removed && error.kind() == std::io::ErrorKind::NotFound => {
                String::new()
            }
            Err(error) => return Err(error.to_string()),
        }
    } else {
        match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if allow_removed && error.kind() == std::io::ErrorKind::NotFound => {
                String::new()
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    let cwd = crate::claude_snapshot::transcript_cwd(&path)
        .filter(|cwd| std::path::Path::new(cwd).is_dir());
    let modified_ms = std::fs::metadata(&path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64);
    Ok(Some(ClaudeRollbackTranscript {
        path,
        source_session_id: session_id.to_owned(),
        content,
        cwd,
        modified_ms,
    }))
}

#[cfg(test)]
pub(super) async fn read_claude_rollback_transcript(
    session_id: &str,
    allow_removed: bool,
) -> Result<Option<ClaudeRollbackTranscript>, String> {
    if crate::native_history::managed_provider_identity()?.is_some() {
        let value = managed_claude_history_read(json!({
            "kind":"transcript", "sessionId":session_id, "allowRemoved":allow_removed,
        }))
        .await?;
        serde_json::from_value(value)
            .map_err(|_| "invalid managed Claude transcript response".into())
    } else {
        read_claude_transcript_local(session_id, allow_removed, false)
    }
}

pub(super) fn worker_request(mut request: Value) -> Value {
    // The host owns these saved display markers. Native readers need only
    // the record's flags and original-chain anchors, regardless of how many
    // large Undo windows have accumulated across epochs.
    if let Some(record) = request.get_mut("rollback").and_then(Value::as_object_mut) {
        record.insert("entries".into(), json!([]));
    }
    request
}

pub(super) fn stamp_managed_snapshot(
    mut snapshot: Value,
    record: crate::rollback_record::RollbackRecord,
) -> Value {
    // Only the provider-UID reader can adjudicate the original native tip.
    // Replace its temporary summary with the host's full saved marker union.
    let can_redo = snapshot["rollback"]["canRedo"] == true;
    let revision = snapshot["revision"].as_i64().unwrap_or(0);
    if let Some(object) = snapshot.as_object_mut() {
        object.remove("rollback");
        object.remove("rolledBackTurns");
    }
    snapshot["revision"] = json!(crate::rollback_record::stamp_rollback_snapshot(
        &mut snapshot,
        revision,
        &record,
        can_redo,
    ));
    crate::native_history::retain_snapshot_display("claude", &mut snapshot);
    snapshot
}

pub(super) async fn managed_claude_history_read(request: Value) -> Result<Value, String> {
    let (uid, gid) = crate::native_history::managed_provider_identity()?
        .ok_or("managed provider identity is absent")?;
    let mut command = tokio::process::Command::new("/usr/bin/setpriv");
    command
        .args([
            "--reuid",
            &uid.to_string(),
            "--regid",
            &gid.to_string(),
            "--clear-groups",
            "--no-new-privs",
            "--",
        ])
        .arg(std::env::current_exe().map_err(|error| error.to_string())?)
        .arg("claude-history-read-worker");
    history_read_command(request, command, (uid, gid)).await
}

pub(super) async fn history_read_command(
    request: Value,
    mut command: tokio::process::Command,
    (uid, gid): (u32, u32),
) -> Result<Value, String> {
    use tokio::io::AsyncReadExt;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "managed Claude history worker did not start")?;
    let result = tokio::time::timeout(MANAGED_HISTORY_TIMEOUT, async {
        let payload = serde_json::to_vec(&request).map_err(|_| "invalid Claude history request")?;
        if payload.len() as u64 > MANAGED_HISTORY_BYTES {
            return Err("Claude history request exceeds read budget");
        }
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Claude history worker has no stdin")?;
        stdin
            .write_all(&payload)
            .await
            .map_err(|_| "Claude history request write failed")?;
        drop(stdin);
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .ok_or("Claude history worker has no stdout")?
            .take(MANAGED_HISTORY_BYTES * 2 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Claude history response read failed")?;
        if bytes.len() as u64 > MANAGED_HISTORY_BYTES * 2 {
            return Err("Claude history response exceeds read budget");
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "Claude history worker wait failed")?;
        if !status.success() {
            return Err("Claude history worker could not read the native store");
        }
        serde_json::from_slice(&bytes).map_err(|_| "invalid Claude history response")
    })
    .await;
    match result {
        Ok(Ok(value)) => Ok(value),
        failure => {
            let _ = child.kill().await;
            let reason: String = match failure {
                Ok(Err(reason)) => reason.into(),
                Err(_) => "managed Claude history read timed out".into(),
                Ok(Ok(_)) => unreachable!(),
            };
            tracing::warn!(event = "freshagent.claude.managed_history_read_failed",
                operation = request["kind"].as_str().unwrap_or("unknown"),
                provider_uid = uid, provider_gid = gid, reason = %reason);
            Err(reason)
        }
    }
}

pub(super) fn claude_history_read(request: &Value) -> Result<Value, String> {
    let metadata = if request["kind"] == "snapshot" && !request["rollback"].is_null() {
        Some(
            serde_json::from_value::<crate::rollback_record::RollbackRecord>(
                request["rollback"].clone(),
            )
            .map_err(|_| "invalid Claude rollback record")?,
        )
        .filter(|record| record.entries.is_empty())
    } else {
        None
    };
    let native_request = metadata.as_ref().map(|_| {
        let mut request = request.clone();
        request["rollback"] = Value::Null;
        request
    });
    let mut result = claude_history_read_inner(native_request.as_ref().unwrap_or(request))?;
    if let Some(record) = metadata {
        // Reuse the existing rollback summary shape over private stdio. The
        // provider tip is checked once here; the host then stamps its markers.
        result["rollback"] = json!({
            "canRedo": crate::claude_snapshot::claude_can_redo_now(&record),
            "undoneDepth": 0, "redoableTurnIds": [],
        });
        result["revision"] = json!(result["revision"]
            .as_i64()
            .unwrap_or(0)
            .max(record.last_op_at_ms));
    }
    Ok(result)
}

fn claude_history_read_inner(request: &Value) -> Result<Value, String> {
    let session_id = request["sessionId"]
        .as_str()
        .filter(|id| {
            !id.is_empty() && !id.contains(['/', '\\']) && !id.chars().any(char::is_control)
        })
        .ok_or("invalid Claude history identity")?;
    match request["kind"].as_str() {
        Some("fork") => {
            let current = read_claude_operation_transcript(request)?
                .ok_or("There is nothing to fork yet: this conversation has no messages.")?;
            let at =
                crate::claude_snapshot::fork_point(&current.content, request["atTurnId"].as_str())
                    .map_err(|error| match error {
                        crate::claude_snapshot::ForkPointError::Empty => {
                            "There is nothing to fork yet: this conversation has no messages."
                        }
                        crate::claude_snapshot::ForkPointError::TurnNotFound => {
                            "That turn is not in this conversation, so it can't be forked from."
                        }
                    })?;
            return serde_json::to_value(ClaudeForkResolution {
                source_session_id: current.source_session_id,
                source_path: current.path,
                at,
            })
            .map_err(|error| error.to_string());
        }
        Some("rollback") => {
            return serde_json::to_value(resolve_claude_rollback(request))
                .map_err(|error| error.to_string())
        }
        Some("source") => {
            return serde_json::to_value(read_claude_rollback_source(request)?)
                .map_err(|error| error.to_string())
        }
        _ => {}
    }
    if request["kind"] == "snapshot" {
        if request["fork"].is_null()
            || crate::claude_snapshot::locate_transcript(session_id).is_some()
            || !request["genesis"].is_null()
        {
            let session_type = request["sessionType"]
                .as_str()
                .filter(|kind| matches!(*kind, "freshclaude" | "kilroy"))
                .ok_or("invalid Claude history session type")?;
            let rollback: Option<crate::rollback_record::RollbackRecord> =
                serde_json::from_value(request["rollback"].clone())
                    .map_err(|_| "invalid Claude rollback record")?;
            let genesis = if request["genesis"].is_null() {
                None
            } else {
                Some(crate::identity_sink::RecordedGenesis {
                    genesis: serde_json::from_value(request["genesis"]["genesis"].clone())
                        .map_err(|_| "invalid Claude genesis")?,
                    updated_at_ms: request["genesis"]["updatedAtMs"]
                        .as_i64()
                        .ok_or("invalid Claude genesis time")?,
                })
            };
            let roots: Vec<PathBuf> = if request["roots"].is_null() {
                crate::claude_snapshot::claude_home_candidates()
            } else {
                serde_json::from_value(request["roots"].clone())
                    .map_err(|_| "invalid Claude store roots")?
            };
            return crate::claude_snapshot::get_claude_snapshot_sync_in(
                &roots,
                session_type,
                session_id,
                genesis.as_ref(),
                rollback.as_ref(),
            )
            .map_err(|error| match error {
                crate::claude_snapshot::ClaudeSnapshotError::NotFound => {
                    "claude session not found".to_string()
                }
                crate::claude_snapshot::ClaudeSnapshotError::Io(message) => message,
            });
        }
    }
    let mut transcript = if request["kind"] == "snapshot" {
        read_claude_operation_transcript(request)?
    } else {
        read_claude_transcript_local(session_id, request["allowRemoved"] == true, true)?
    };
    if transcript.is_none() && !request["fork"].is_null() {
        let recipe: freshell_agent_runtime::ClaudeForkRecipe =
            serde_json::from_value(request["fork"].clone())
                .map_err(|_| "invalid Claude fork recipe")?;
        recipe.validate(session_id)?;
        let home = std::env::var("HOME").map_err(|_| "managed provider HOME unavailable")?;
        let parent = freshell_agent_runtime::read_verified_claude_fork_parent(
            std::path::Path::new(&home),
            &recipe,
        )?;
        let cutoff = match &recipe.target {
            freshell_agent_runtime::ClaudeForkTarget::Prefix { cutoff_uuid, .. } => {
                Some(cutoff_uuid.as_str())
            }
            freshell_agent_runtime::ClaudeForkTarget::Empty => None,
        };
        let mut source = read_claude_transcript_local(&recipe.parent_session_id, false, true)?
            .ok_or("Claude fork parent missing")?;
        if source.content != parent {
            return Err("Claude fork source changed during read".into());
        }
        source.content = crate::claude_snapshot::fork_prefix(&parent, cutoff)?;
        transcript = Some(source);
    }
    match request["kind"].as_str() {
        Some("transcript") => serde_json::to_value(transcript).map_err(|error| error.to_string()),
        Some("snapshot") => {
            let transcript = transcript.ok_or("claude session not found")?;
            let rollback: Option<crate::rollback_record::RollbackRecord> =
                serde_json::from_value(request["rollback"].clone())
                    .map_err(|_| "invalid Claude rollback record")?;
            if let Some(original) = rollback
                .as_ref()
                .and_then(|record| record.original_session_id.as_deref())
            {
                let _ = read_claude_rollback_source(&json!({"sessionId":original}))?;
            }
            let session_type = request["sessionType"]
                .as_str()
                .filter(|kind| matches!(*kind, "freshclaude" | "kilroy"))
                .ok_or("invalid Claude history session type")?;
            let subagents = crate::claude_projection::FsSubagents::for_transcript(&transcript.path);
            let projection = crate::claude_projection::ClaudeTranscriptProjector::project_with(
                session_id,
                &transcript.content,
                &subagents,
            );
            let mut snapshot = crate::claude_snapshot::build_claude_snapshot_from_projection(
                session_type,
                session_id,
                projection,
                0,
                rollback.as_ref(),
            );
            let basis = transcript
                .modified_ms
                .unwrap_or_else(|| {
                    snapshot["turns"]
                        .as_array()
                        .map_or(0, |turns| turns.len() as i64)
                })
                .max(0);
            snapshot["revision"] = json!(rollback
                .as_ref()
                .map_or(basis, |record| basis.max(record.last_op_at_ms)));
            Ok(snapshot)
        }
        _ => Err("unknown Claude history read".into()),
    }
}

/// Internal session-host worker. Runs with the existing provider UID/GID drop;
/// native history remains provider-owned and is returned only over private stdio.
pub fn run_claude_history_read_worker() -> Result<(), String> {
    use std::io::Read;
    let mut input = Vec::new();
    std::io::stdin()
        .take(MANAGED_HISTORY_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|_| "Claude history request read failed")?;
    if input.len() as u64 > MANAGED_HISTORY_BYTES {
        return Err("Claude history request exceeds read budget".into());
    }
    let request: Value =
        serde_json::from_slice(&input).map_err(|_| "invalid Claude history request")?;
    let result = claude_history_read(&request)?;
    let bytes =
        serde_json::to_vec(&result).map_err(|_| "Claude history response encoding failed")?;
    if bytes.len() as u64 > MANAGED_HISTORY_BYTES * 2 {
        return Err("Claude history response exceeds read budget".into());
    }
    std::io::Write::write_all(&mut std::io::stdout(), &bytes)
        .map_err(|_| "Claude history response write failed".into())
}
