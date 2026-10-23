//! Name-reliability Task 4: the success response of the fresh-agent pane and
//! tab rename routes once the naming store accepted the request. The message
//! follows the rename's `outcome`, so a refused automation rename never says
//! "session renamed" beside `applied: false` (the CLI prints this body and
//! the MCP tool returns it).

use axum::response::Response;
use freshell_protocol::session_names::{RenameOutcome, SessionNameUpdate};
use serde_json::{json, Map, Value};

/// `{status:'ok', data:{tabId?, paneId?, nameRef, sessionName}, message}`.
pub(crate) fn scoped_rename_response(
    tab_id: Option<&str>,
    pane_id: Option<&str>,
    update: &SessionNameUpdate,
) -> Response {
    let mut data = Map::new();
    if let Some(tab_id) = tab_id {
        data.insert("tabId".into(), json!(tab_id));
    }
    if let Some(pane_id) = pane_id {
        data.insert("paneId".into(), json!(pane_id));
    }
    data.insert(
        "nameRef".into(),
        serde_json::to_value(&update.record.name_ref).unwrap_or(Value::Null),
    );
    data.insert(
        "sessionName".into(),
        serde_json::to_value(update).unwrap_or(Value::Null),
    );
    crate::ok_json(Value::Object(data), &rename_message(update))
}

/// "session renamed" when the saved name now is the requested text (or no
/// outcome was reported); otherwise `session name not applied: <reason>`,
/// the reason as the wire spells it (`protected_name`, `default_label`).
fn rename_message(update: &SessionNameUpdate) -> String {
    match update.outcome {
        Some(RenameOutcome {
            applied: false,
            reason,
        }) => {
            let reason = reason
                .and_then(|reason| serde_json::to_value(reason).ok())
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_else(|| "unknown".to_string());
            format!("session name not applied: {reason}")
        }
        _ => "session renamed".to_string(),
    }
}
