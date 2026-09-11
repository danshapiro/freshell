//! Truthful capability projection for fresh-agent snapshots crossing a hosted gateway.
//!
//! Provider snapshots describe provider-native behavior. A hosted web gateway
//! may expose a smaller operation set, so the public projection is the strict
//! intersection. Unknown provider/session pairs and malformed capability maps
//! fail closed.

use serde_json::{Map, Value};

const BOOLEAN_CAPABILITIES: &[&str] = &[
    "send",
    "interrupt",
    "approvals",
    "questions",
    "fork",
    "worktrees",
    "diffs",
    "childThreads",
    "undo",
    "redo",
];

/// Rewrites every recognized snapshot in `payload`, including snapshots nested
/// in a `freshAgent.event` envelope. Non-snapshot provider events are untouched.
pub fn project_hosted_snapshot(payload: &mut Value, provider: &str, session_type: &str) {
    let known_pair = matches!(
        (provider, session_type),
        ("claude", "freshclaude")
            | ("claude", "kilroy")
            | ("codex", "freshcodex")
            | ("opencode", "freshopencode")
    );
    visit(payload, provider, session_type, known_pair);
}

fn visit(value: &mut Value, provider: &str, session_type: &str, known_pair: bool) {
    let Value::Object(object) = value else {
        return;
    };
    let is_snapshot = matches!(
        object.get("type").and_then(Value::as_str),
        Some("freshAgent.session.snapshot" | "freshAgent.snapshot")
    );
    if is_snapshot {
        let identity_matches = object.get("provider").and_then(Value::as_str) == Some(provider)
            && object.get("sessionType").and_then(Value::as_str) == Some(session_type);
        project_capabilities(object, provider, known_pair && identity_matches);
    }
    for child in object.values_mut() {
        visit(child, provider, session_type, known_pair);
    }
}

fn project_capabilities(snapshot: &mut Map<String, Value>, provider: &str, known_pair: bool) {
    let native = snapshot.get("capabilities").and_then(Value::as_object);
    let required_valid = native.is_some_and(|capabilities| {
        ["send", "interrupt", "approvals", "questions", "fork"]
            .into_iter()
            .all(|name| capabilities.get(name).and_then(Value::as_bool).is_some())
    });

    let mut projected = Map::new();
    if known_pair && required_valid {
        let native = native.expect("validated capability object");
        for capability in [
            "send",
            "interrupt",
            "approvals",
            "questions",
            "diffs",
            "undo",
        ] {
            projected.insert(
                capability.into(),
                Value::Bool(
                    native
                        .get(capability)
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
            );
        }
        let fork = matches!(provider, "codex" | "opencode")
            && native.get("fork").and_then(Value::as_bool).unwrap_or(false);
        projected.insert("fork".into(), Value::Bool(fork));
        projected.insert("worktrees".into(), Value::Bool(false));
        // Child threads are provider-owned topology displayed read-only inside
        // this soul. Forwarding them does not allocate a Freshell soul or
        // grant independent lifecycle authority.
        projected.insert(
            "childThreads".into(),
            Value::Bool(
                native
                    .get("childThreads")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
        );
        let redo =
            provider != "codex" && native.get("redo").and_then(Value::as_bool).unwrap_or(false);
        projected.insert("redo".into(), Value::Bool(redo));
        if let Some(scopes) = native
            .get("settingScopes")
            .filter(|value| valid_scopes(value))
        {
            projected.insert("settingScopes".into(), scopes.clone());
        }
    } else {
        for capability in BOOLEAN_CAPABILITIES {
            projected.insert((*capability).into(), Value::Bool(false));
        }
    }

    let redo_supported = projected
        .get("redo")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    snapshot.insert("capabilities".into(), Value::Object(projected));
    project_rollback(snapshot.get_mut("rollback"), redo_supported);
}

fn valid_scopes(value: &Value) -> bool {
    let Some(scopes) = value.as_object() else {
        return false;
    };
    scopes.iter().all(|(name, value)| {
        matches!(
            name.as_str(),
            "model" | "effort" | "sandbox" | "permissionMode"
        ) && matches!(
            value.as_str(),
            Some("per-send" | "create-only" | "unsupported")
        )
    })
}

fn project_rollback(rollback: Option<&mut Value>, redo_supported: bool) {
    let Some(rollback) = rollback.and_then(Value::as_object_mut) else {
        return;
    };
    let can_redo = redo_supported
        && rollback
            .get("canRedo")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    rollback.insert("canRedo".into(), Value::Bool(can_redo));
    if !can_redo
        || !rollback
            .get("redoableTurnIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().all(Value::is_string))
    {
        rollback.remove("redoableTurnIds");
    }
}
