//! Plain-text capture shared by local and hosted fresh-agent REST lanes.
//! The byte cap always ends at a UTF-8 boundary.

use serde_json::Value;

/// Render role-prefixed turn text, commands, output and error-only turns.
pub fn render_snapshot_text(snapshot: &Value, max_bytes: usize) -> (String, bool) {
    let mut output = String::new();
    if let Some(turns) = snapshot.get("turns").and_then(Value::as_array) {
        for turn in turns {
            let role = turn
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("assistant");
            let mut body = Vec::new();
            if let Some(items) = turn.get("items").and_then(Value::as_array) {
                for item in items {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        body.push(text);
                    } else if let Some(command) = item.get("command").and_then(Value::as_str) {
                        body.push(command);
                    } else if let Some(result) = item.get("output").and_then(Value::as_str) {
                        body.push(result);
                    }
                }
            }
            if body.is_empty() {
                // An item-less turn carrying only the durable error module
                // (a claude API error or failed local command) reads as its
                // error; anything else falls back to the summary.
                if let Some(message) = turn.pointer("/error/message").and_then(Value::as_str) {
                    body.push(message);
                } else if let Some(summary) = turn.get("summary").and_then(Value::as_str) {
                    body.push(summary);
                }
            }
            if !body.is_empty() {
                output.push_str(role);
                output.push_str(": ");
                output.push_str(&body.join("\n"));
                output.push('\n');
            }
        }
    }
    if output.len() <= max_bytes {
        return (output, false);
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !output.is_char_boundary(boundary) {
        boundary -= 1;
    }
    output.truncate(boundary);
    (output, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_text_renderer_is_plain_and_utf8_bounded() {
        let snapshot = json!({"turns":[
            {"role":"user","summary":"ignored","items":[{"kind":"text","text":"héllo"}]},
            {"role":"assistant","summary":"world","items":[]}
        ]});
        let (full, truncated) = render_snapshot_text(&snapshot, 100);
        assert_eq!(full, "user: héllo\nassistant: world\n");
        assert!(!truncated);
        let (short, truncated) = render_snapshot_text(&snapshot, 8);
        assert!(short.len() <= 8);
        assert!(short.is_char_boundary(short.len()));
        assert!(truncated);
    }

    #[test]
    fn snapshot_text_renders_error_only_turns_by_their_error_message() {
        // Real claude snapshots (pinned CLI 2.1.237 goldens): a failed /compact
        // and an API error are item-less turns carrying only the error module.
        for (golden, expected) in [
            (
                include_str!("../../../test/fixtures/fresh-agent/claude/real-cli-2.1.237/compact-fail/snapshot.golden.json"),
                "system: Error during compaction: API Error: 400 compaction refused by fake\n",
            ),
            (
                include_str!("../../../test/fixtures/fresh-agent/claude/real-cli-2.1.237/api-error/snapshot.golden.json"),
                "assistant: API Error: 400 fixture bad request\n",
            ),
        ] {
            let snapshot: Value = serde_json::from_str(golden).unwrap();
            let (text, _) = render_snapshot_text(&snapshot, 1 << 20);
            assert!(text.contains(expected), "{text}");
        }
    }
}
