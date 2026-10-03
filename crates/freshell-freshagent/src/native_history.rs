//! Read a selected native transcript without creating a provider runtime.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub const MAX_HISTORY_BYTES: u64 = 16 * 1024 * 1024;

pub fn read(provider: &str, home: &Path, session_id: &str) -> Result<Value, String> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) {
        return Err("invalid native session identity".into());
    }
    let mut snapshot = match provider {
        "codex" => crate::codex::native_history::read(home, session_id)?,
        "opencode" => read_opencode(home, session_id)?,
        _ => return Err("native history reader does not support this provider".into()),
    };
    if let Some(capabilities) = snapshot["capabilities"].as_object_mut() {
        for value in capabilities.values_mut() {
            if value.is_boolean() {
                *value = json!(false);
            }
        }
    }
    snapshot["status"] = json!("idle");
    snapshot["extensions"][provider]["ownerKind"] = json!("vacant");
    snapshot["extensions"][provider]["nativeHistoryAvailable"] = json!(true);
    if serde_json::to_vec(&snapshot)
        .map_err(|e| e.to_string())?
        .len() as u64
        > MAX_HISTORY_BYTES
    {
        return Err("native transcript exceeds history read limit".into());
    }
    Ok(snapshot)
}

fn read_opencode(home: &Path, id: &str) -> Result<Value, String> {
    let connection = Connection::open_with_flags(
        home.join(".local/share/opencode/opencode.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    // One read transaction includes committed WAL rows and keeps messages and parts consistent.
    connection
        .execute_batch("BEGIN")
        .map_err(|e| e.to_string())?;
    let mut info: Value = connection.query_row(
        "SELECT title, time_updated, revert FROM session WHERE id = ?1", [id],
        |row| Ok(json!({"id":id,"title":row.get::<_, String>(0)?,"time":{"updated":row.get::<_, i64>(1)?},
            "revert":row.get::<_, Option<String>>(2)?.and_then(|text| serde_json::from_str::<Value>(&text).ok())})))
        .optional().map_err(|e| e.to_string())?.ok_or("saved native session not found")?;
    if info["revert"].is_null() {
        info.as_object_mut().unwrap().remove("revert");
    }
    let mut messages = Vec::new();
    let mut bytes = 0u64;
    let mut statement = connection
        .prepare("SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created, id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (message_id, text) = row.map_err(|e| e.to_string())?;
        bytes += text.len() as u64;
        let mut message: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        message["id"] = json!(message_id);
        let mut parts = Vec::new();
        let mut statement = connection.prepare("SELECT id, data FROM part WHERE session_id = ?1 AND message_id = ?2 ORDER BY time_created, id")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([id, &message_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (part_id, text) = row.map_err(|e| e.to_string())?;
            bytes += text.len() as u64;
            if bytes > MAX_HISTORY_BYTES {
                return Err("native transcript exceeds history read limit".into());
            }
            let mut part: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            part["id"] = json!(part_id);
            parts.push(part);
        }
        messages.push(json!({"info":message,"parts":parts}));
    }
    Ok(crate::build_opencode_snapshot_json(
        id,
        &info,
        &json!(messages),
        None,
    ))
}
