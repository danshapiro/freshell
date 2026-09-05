//! Project actual provider items into the shared changed-files and child panels.
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(super) fn transcript_metadata(turns: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let mut files = BTreeMap::new();
    let mut children = BTreeMap::new();
    for item in turns
        .iter()
        .filter_map(|turn| turn.get("items").and_then(Value::as_array))
        .flatten()
    {
        match item.get("kind").and_then(Value::as_str) {
            Some("file_change") => {
                for change in item
                    .get("changes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(path) = change
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|p| !p.is_empty())
                    else {
                        continue;
                    };
                    let mut file = json!({ "id": path, "path": path });
                    if let Some(status) = item.get("status").and_then(Value::as_str) {
                        file["status"] = json!(status);
                    }
                    // One row per path, reflecting the latest operation on that file.
                    files.insert(path.to_owned(), file);
                }
            }
            Some("collab_agent") => {
                for id in item
                    .get("receiverThreadIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    // Keep the first origin (spawn), not a later wait/send operation.
                    children.entry(id.to_owned()).or_insert_with(|| json!({
                        "id": id, "threadId": id, "origin": item.get("tool").and_then(Value::as_str).unwrap_or("codex"),
                    }));
                }
            }
            _ => {}
        }
    }
    (
        files.into_values().collect(),
        children.into_values().collect(),
    )
}
