use std::path::Path;

use serde_json::Value;

use super::corrupt_generation;

fn invalid(path: &Path, field: &str, expected: &str) -> std::io::Error {
    corrupt_generation(path, format!("`{field}` must be {expected}"))
}

fn nonempty_string(path: &Path, owner: &Value, field: &str, name: &str) -> std::io::Result<()> {
    owner
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|_| ())
        .ok_or_else(|| invalid(path, name, "a non-empty string"))
}

fn string(path: &Path, owner: &Value, field: &str, name: &str) -> std::io::Result<()> {
    owner
        .get(field)
        .and_then(Value::as_str)
        .map(|_| ())
        .ok_or_else(|| invalid(path, name, "a string"))
}

fn boolean(path: &Path, owner: &Value, field: &str, name: &str) -> std::io::Result<()> {
    owner
        .get(field)
        .and_then(Value::as_bool)
        .map(|_| ())
        .ok_or_else(|| invalid(path, name, "a boolean"))
}

fn optional_string(path: &Path, owner: &Value, field: &str, name: &str) -> std::io::Result<()> {
    if owner.get(field).is_none() {
        return Ok(());
    }
    string(path, owner, field, name)
}

fn optional_bool(path: &Path, owner: &Value, field: &str, name: &str) -> std::io::Result<()> {
    if owner.get(field).is_none() {
        return Ok(());
    }
    boolean(path, owner, field, name)
}

fn optional_enum(
    path: &Path,
    owner: &Value,
    field: &str,
    name: &str,
    allowed: &[&str],
) -> std::io::Result<()> {
    let Some(value) = owner.get(field) else {
        return Ok(());
    };
    if value
        .as_str()
        .is_some_and(|candidate| allowed.contains(&candidate))
    {
        Ok(())
    } else {
        Err(invalid(path, name, &format!("one of {allowed:?}")))
    }
}

fn session_ref(path: &Path, payload: &Value, name: &str) -> std::io::Result<()> {
    let Some(reference) = payload.get("sessionRef") else {
        return Ok(());
    };
    let object = reference
        .as_object()
        .ok_or_else(|| invalid(path, name, "an object"))?;
    nonempty_string(path, reference, "provider", &format!("{name}.provider"))?;
    nonempty_string(path, reference, "sessionId", &format!("{name}.sessionId"))?;
    if object.contains_key("serverInstanceId") {
        return Err(invalid(path, &format!("{name}.serverInstanceId"), "absent"));
    }
    Ok(())
}

fn live_terminal(path: &Path, payload: &Value, name: &str) -> std::io::Result<()> {
    let Some(handle) = payload.get("liveTerminal") else {
        return Ok(());
    };
    handle
        .as_object()
        .ok_or_else(|| invalid(path, name, "an object"))?;
    nonempty_string(path, handle, "terminalId", &format!("{name}.terminalId"))?;
    nonempty_string(
        path,
        handle,
        "serverInstanceId",
        &format!("{name}.serverInstanceId"),
    )
}

fn nonnegative_integer(path: &Path, owner: &Value, field: &str, name: &str) -> std::io::Result<()> {
    if owner
        .get(field)
        .and_then(Value::as_i64)
        .is_some_and(|v| v >= 0)
    {
        Ok(())
    } else {
        Err(invalid(path, name, "a non-negative integer"))
    }
}

fn codex_durability(path: &Path, payload: &Value, name: &str) -> std::io::Result<()> {
    let Some(value) = payload.get("codexDurability") else {
        return Ok(());
    };
    value
        .as_object()
        .ok_or_else(|| invalid(path, name, "an object"))?;
    if value.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
        return Err(invalid(path, &format!("{name}.schemaVersion"), "1"));
    }
    optional_enum(
        path,
        value,
        "state",
        &format!("{name}.state"),
        &[
            "identity_pending",
            "captured_pre_turn",
            "turn_in_progress_unproven",
            "proof_checking",
            "durable",
            "durable_resuming",
            "durability_unproven_after_completion",
            "non_restorable",
        ],
    )?;
    if value.get("state").is_none() {
        return Err(invalid(path, &format!("{name}.state"), "a supported state"));
    }
    for field in ["durableThreadId", "nonRestorableReason"] {
        if value.get(field).is_some() {
            nonempty_string(path, value, field, &format!("{name}.{field}"))?;
        }
    }
    if value.get("turnCompletedAt").is_some() {
        nonnegative_integer(
            path,
            value,
            "turnCompletedAt",
            &format!("{name}.turnCompletedAt"),
        )?;
    }
    if let Some(candidate) = value.get("candidate") {
        candidate
            .as_object()
            .ok_or_else(|| invalid(path, &format!("{name}.candidate"), "an object"))?;
        if candidate.get("provider").and_then(Value::as_str) != Some("codex") {
            return Err(invalid(
                path,
                &format!("{name}.candidate.provider"),
                "`codex`",
            ));
        }
        for field in ["candidateThreadId", "rolloutPath"] {
            nonempty_string(path, candidate, field, &format!("{name}.candidate.{field}"))?;
        }
        optional_enum(
            path,
            candidate,
            "source",
            &format!("{name}.candidate.source"),
            &[
                "thread_start_response",
                "thread_started_notification",
                "thread_fork_response",
                "restored_client_state",
                "durable_resume",
            ],
        )?;
        if candidate.get("source").is_none() {
            return Err(invalid(
                path,
                &format!("{name}.candidate.source"),
                "a supported source",
            ));
        }
        nonnegative_integer(
            path,
            candidate,
            "capturedAt",
            &format!("{name}.candidate.capturedAt"),
        )?;
        if candidate.get("cliVersion").is_some() {
            nonempty_string(
                path,
                candidate,
                "cliVersion",
                &format!("{name}.candidate.cliVersion"),
            )?;
        }
    }
    if let Some(failure) = value.get("lastProofFailure") {
        failure
            .as_object()
            .ok_or_else(|| invalid(path, &format!("{name}.lastProofFailure"), "an object"))?;
        optional_enum(
            path,
            failure,
            "reason",
            &format!("{name}.lastProofFailure.reason"),
            &[
                "invalid_path",
                "missing",
                "not_regular_file",
                "empty",
                "malformed_json",
                "wrong_record_type",
                "missing_payload_id",
                "mismatched_thread_id",
                "read_error",
            ],
        )?;
        if failure.get("reason").is_none() {
            return Err(invalid(
                path,
                &format!("{name}.lastProofFailure.reason"),
                "a supported reason",
            ));
        }
        nonempty_string(
            path,
            failure,
            "message",
            &format!("{name}.lastProofFailure.message"),
        )?;
        nonnegative_integer(
            path,
            failure,
            "checkedAt",
            &format!("{name}.lastProofFailure.checkedAt"),
        )?;
    }
    Ok(())
}

fn validate_terminal(path: &Path, payload: &Value, name: &str) -> std::io::Result<()> {
    optional_enum(
        path,
        payload,
        "mode",
        &format!("{name}.mode"),
        &[
            "shell",
            "claude",
            "codex",
            "opencode",
            "gemini",
            "kimi",
            "amplifier",
        ],
    )?;
    let mode = payload
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(path, &format!("{name}.mode"), "a supported terminal mode"))?;
    optional_enum(
        path,
        payload,
        "shell",
        &format!("{name}.shell"),
        &["system", "cmd", "powershell", "wsl"],
    )?;
    optional_string(path, payload, "initialCwd", &format!("{name}.initialCwd"))?;
    session_ref(path, payload, &format!("{name}.sessionRef"))?;
    if payload
        .get("sessionRef")
        .and_then(|reference| reference.get("provider"))
        .and_then(Value::as_str)
        .is_some_and(|provider| provider != mode)
    {
        return Err(invalid(
            path,
            &format!("{name}.sessionRef.provider"),
            &format!("`{mode}`"),
        ));
    }
    live_terminal(path, payload, &format!("{name}.liveTerminal"))?;
    if mode != "codex" && payload.get("codexDurability").is_some() {
        return Err(invalid(
            path,
            &format!("{name}.codexDurability"),
            "absent unless mode is `codex`",
        ));
    }
    codex_durability(path, payload, &format!("{name}.codexDurability"))
}

fn validate_browser(path: &Path, payload: &Value, name: &str) -> std::io::Result<()> {
    nonempty_string(path, payload, "url", &format!("{name}.url"))?;
    boolean(
        path,
        payload,
        "devToolsOpen",
        &format!("{name}.devToolsOpen"),
    )
}

fn validate_editor(path: &Path, payload: &Value, name: &str) -> std::io::Result<()> {
    if !matches!(
        payload.get("filePath"),
        Some(Value::Null | Value::String(_))
    ) {
        return Err(invalid(
            path,
            &format!("{name}.filePath"),
            "a string or null",
        ));
    }
    if !matches!(
        payload.get("language"),
        Some(Value::Null | Value::String(_))
    ) {
        return Err(invalid(
            path,
            &format!("{name}.language"),
            "a string or null",
        ));
    }
    boolean(path, payload, "readOnly", &format!("{name}.readOnly"))?;
    optional_enum(
        path,
        payload,
        "viewMode",
        &format!("{name}.viewMode"),
        &["source", "preview"],
    )?;
    if payload.get("viewMode").is_none() {
        return Err(invalid(
            path,
            &format!("{name}.viewMode"),
            "`source` or `preview`",
        ));
    }
    boolean(path, payload, "wordWrap", &format!("{name}.wordWrap"))
}

fn validate_fresh_agent(path: &Path, payload: &Value, name: &str) -> std::io::Result<()> {
    let session_type = payload
        .get("sessionType")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(path, &format!("{name}.sessionType"), "a supported value"))?;
    let expected_provider = match session_type {
        "freshclaude" | "kilroy" => "claude",
        "freshcodex" => "codex",
        "freshopencode" => "opencode",
        _ => {
            return Err(invalid(
                path,
                &format!("{name}.sessionType"),
                "a supported value",
            ))
        }
    };
    if payload.get("provider").and_then(Value::as_str) != Some(expected_provider) {
        return Err(invalid(
            path,
            &format!("{name}.provider"),
            &format!("`{expected_provider}` for `{session_type}`"),
        ));
    }
    session_ref(path, payload, &format!("{name}.sessionRef"))?;
    if payload
        .get("sessionRef")
        .and_then(|reference| reference.get("provider"))
        .and_then(Value::as_str)
        .is_some_and(|provider| provider != expected_provider)
    {
        return Err(invalid(
            path,
            &format!("{name}.sessionRef.provider"),
            &format!("`{expected_provider}`"),
        ));
    }
    for field in ["initialCwd", "model", "permissionMode", "effort"] {
        optional_string(path, payload, field, &format!("{name}.{field}"))?;
    }
    optional_enum(
        path,
        payload,
        "sandbox",
        &format!("{name}.sandbox"),
        &["read-only", "workspace-write", "danger-full-access"],
    )?;
    optional_enum(
        path,
        payload,
        "style",
        &format!("{name}.style"),
        &["sans", "serif", "mono"],
    )?;
    for field in [
        "settingsDismissed",
        "showThinking",
        "showTools",
        "showTimecodes",
    ] {
        optional_bool(path, payload, field, &format!("{name}.{field}"))?;
    }
    if let Some(plugins) = payload.get("plugins") {
        if !plugins
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
        {
            return Err(invalid(
                path,
                &format!("{name}.plugins"),
                "an array of strings",
            ));
        }
    }
    if let Some(selection) = payload.get("modelSelection") {
        selection
            .as_object()
            .ok_or_else(|| invalid(path, &format!("{name}.modelSelection"), "an object"))?;
        optional_enum(
            path,
            selection,
            "kind",
            &format!("{name}.modelSelection.kind"),
            &["tracked", "exact"],
        )?;
        if selection.get("kind").is_none() {
            return Err(invalid(
                path,
                &format!("{name}.modelSelection.kind"),
                "`tracked` or `exact`",
            ));
        }
        nonempty_string(
            path,
            selection,
            "modelId",
            &format!("{name}.modelSelection.modelId"),
        )?;
    }
    if let Some(error) = payload.get("restoreError") {
        error
            .as_object()
            .ok_or_else(|| invalid(path, &format!("{name}.restoreError"), "an object"))?;
        if error.get("code").and_then(Value::as_str) != Some("RESTORE_UNAVAILABLE") {
            return Err(invalid(
                path,
                &format!("{name}.restoreError.code"),
                "`RESTORE_UNAVAILABLE`",
            ));
        }
        optional_enum(
            path,
            error,
            "reason",
            &format!("{name}.restoreError.reason"),
            &[
                "missing_canonical_identity",
                "invalid_legacy_restore_target",
                "dead_live_handle",
                "provider_runtime_failed",
                "durable_artifact_missing",
            ],
        )?;
        if error.get("reason").is_none() {
            return Err(invalid(
                path,
                &format!("{name}.restoreError.reason"),
                "a supported reason",
            ));
        }
    }
    Ok(())
}

fn validate_extension(path: &Path, payload: &Value, name: &str) -> std::io::Result<()> {
    nonempty_string(
        path,
        payload,
        "extensionName",
        &format!("{name}.extensionName"),
    )?;
    payload
        .get("props")
        .and_then(Value::as_object)
        .map(|_| ())
        .ok_or_else(|| invalid(path, &format!("{name}.props"), "an object"))
}

fn validate_pane(
    path: &Path,
    pane: &Value,
    record_index: usize,
    pane_index: usize,
) -> std::io::Result<()> {
    let name = format!("records[{record_index}].panes[{pane_index}]");
    pane.as_object()
        .ok_or_else(|| invalid(path, &name, "an object"))?;
    nonempty_string(path, pane, "paneId", &format!("{name}.paneId"))?;
    let kind = pane
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .ok_or_else(|| invalid(path, &format!("{name}.kind"), "a supported pane kind"))?;
    let payload = pane
        .get("payload")
        .filter(|payload| payload.is_object())
        .ok_or_else(|| invalid(path, &format!("{name}.payload"), "an object"))?;
    let payload_name = format!("{name}.payload");
    match kind {
        "terminal" => validate_terminal(path, payload, &payload_name),
        "browser" => validate_browser(path, payload, &payload_name),
        "editor" => validate_editor(path, payload, &payload_name),
        "fresh-agent" => validate_fresh_agent(path, payload, &payload_name),
        "extension" => validate_extension(path, payload, &payload_name),
        "picker" => Ok(()),
        _ => Err(invalid(
            path,
            &format!("{name}.kind"),
            "one of terminal, browser, editor, fresh-agent, extension, or picker",
        )),
    }
}

/// Validate recovery data before any reader indexes, unions, or reports it.
pub(super) fn validate_generation(path: &Path, value: &Value) -> std::io::Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| corrupt_generation(path, "top-level value is not an object"))?;
    nonempty_string(path, value, "deviceId", "deviceId")?;
    nonempty_string(path, value, "clientInstanceId", "clientInstanceId")?;
    nonempty_string(path, value, "serverInstanceId", "serverInstanceId")?;
    string(path, value, "deviceLabel", "deviceLabel")?;
    for field in ["capturedAt", "snapshotRevision"] {
        object
            .get(field)
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid(path, field, "an integer"))?;
    }
    let records = object
        .get("records")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(path, "records", "an array"))?;
    for (record_index, record) in records.iter().enumerate() {
        let name = format!("records[{record_index}]");
        let record_object = record
            .as_object()
            .ok_or_else(|| invalid(path, &name, "an object"))?;
        nonempty_string(path, record, "tabKey", &format!("{name}.tabKey"))?;
        nonempty_string(path, record, "tabId", &format!("{name}.tabId"))?;
        string(path, record, "tabName", &format!("{name}.tabName"))?;
        if record_object.get("status").and_then(Value::as_str) != Some("open") {
            return Err(invalid(path, &format!("{name}.status"), "`open`"));
        }
        for field in ["revision", "updatedAt", "paneCount"] {
            record_object
                .get(field)
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid(path, &format!("{name}.{field}"), "an integer"))?;
        }
        let panes = record_object
            .get("panes")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid(path, &format!("{name}.panes"), "an array"))?;
        for (pane_index, pane) in panes.iter().enumerate() {
            validate_pane(path, pane, record_index, pane_index)?;
        }
    }
    Ok(())
}
