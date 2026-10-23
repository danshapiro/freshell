//! Shared `task_delegation` presentation helpers: the delegation header title,
//! the one-line activity preview of a delegated agent's tool call, and the
//! activity-row cap. opencode (`task` tool parts joined with the child
//! session's messages) and claude (`Agent`/`Task` tool calls joined with the
//! subagent transcript) project the same item shape through these helpers.

use serde_json::Value;

/// The most child-activity rows embedded per delegation. Full detail lives in
/// the child session; this is a summary strip.
pub(crate) const DELEGATION_ACTIVITY_ROW_CAP: usize = 200;

/// The opencode TUI header: `titlecase(subagent_type ?? "General") + " Task"`
/// (+ " (background)") + " — " + description.
pub(crate) fn task_delegation_title(subagent: &str, background: bool, description: &str) -> String {
    let mut chars = subagent.chars();
    let titlecased = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    };
    let name = if titlecased.trim().is_empty() {
        "General".to_string()
    } else {
        titlecased
    };
    let marker = if background { " (background)" } else { "" };
    format!("{name} Task{marker} — {description}")
}

/// One-line child-activity preview (the client's `getToolPreview` core cases).
/// Tool names match case-insensitively (opencode `read`, claude `Read`) and
/// path inputs accept both spellings (opencode `filePath`, claude
/// `file_path`). Unknown tools (or known tools with no preview key) fall back
/// to compact JSON verbatim, braces included.
pub(crate) fn delegation_activity_preview(tool: &str, input: &Value) -> String {
    let get = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| input.get(*key).and_then(Value::as_str))
            .unwrap_or("")
    };
    let preview = match tool.to_ascii_lowercase().as_str() {
        "bash" | "shell" => get(&["command"]),
        "read" | "write" | "edit" | "multiedit" => get(&["filePath", "file_path"]),
        "notebookedit" => get(&["notebook_path", "notebookPath"]),
        "grep" | "glob" => get(&["pattern"]),
        "task" | "agent" => get(&["description"]),
        "webfetch" => get(&["url"]),
        _ => "",
    };
    let text = if preview.is_empty() {
        serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
    } else {
        preview.to_string()
    };
    text.chars().take(120).collect()
}
