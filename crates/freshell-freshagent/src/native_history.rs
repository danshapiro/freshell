//! Read a selected native transcript without creating a provider runtime.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{io::Read, path::Path};

pub const MAX_HISTORY_BYTES: u64 = 16 * 1024 * 1024;

pub fn read(provider: &str, home: &Path, session_id: &str) -> Result<Value, String> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) {
        return Err("invalid native session identity".into());
    }
    let snapshot = match provider {
        "claude" | "kilroy" => read_claude(home, session_id, provider)?,
        "codex" => crate::codex::native_history::read(home, session_id)?,
        "opencode" => read_opencode(home, session_id)?,
        _ => return Err("native history reader does not support this provider".into()),
    };
    readonly_snapshot(provider, snapshot)
}

pub(crate) fn readonly_snapshot(provider: &str, mut snapshot: Value) -> Result<Value, String> {
    if let Some(capabilities) = snapshot["capabilities"].as_object_mut() {
        for value in capabilities.values_mut() {
            if value.is_boolean() {
                *value = json!(false);
            }
        }
    }
    snapshot["status"] = json!("idle");
    let wire_provider = if provider == "kilroy" {
        "claude"
    } else {
        provider
    };
    snapshot["extensions"][wire_provider]["ownerKind"] = json!("vacant");
    snapshot["extensions"][wire_provider]["nativeHistoryAvailable"] = json!(true);
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
    let path = home.join(".local/share/opencode/opencode.db");
    let companions_absent =
        || !path.with_extension("db-wal").exists() && !path.with_extension("db-shm").exists();
    // A clean WAL close removes its companions. SQLite otherwise needs a writable
    // directory even for READ_ONLY. Only the companion-free snapshot is immutable;
    // existing WAL uses SQLite's normal transaction so committed rows remain visible.
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let fingerprint = (
        metadata.len(),
        metadata.modified().map_err(|e| e.to_string())?,
    );
    let immutable = companions_absent();
    let connection = if immutable {
        let absolute = path.canonicalize().map_err(|e| e.to_string())?;
        let uri_path = absolute
            .to_str()
            .ok_or("native database path is not UTF-8")?
            .replace('%', "%25")
            .replace('?', "%3F")
            .replace('#', "%23");
        Connection::open_with_flags(
            format!("file:{uri_path}?immutable=1"),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )
    } else {
        Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }
    .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    // One read transaction includes committed WAL rows and keeps messages and parts consistent.
    connection
        .execute_batch("BEGIN")
        .map_err(|e| e.to_string())?;
    // Older native schemas predate revert; inspect capabilities without migrating the store.
    let mut has_revert = false;
    let mut columns = connection
        .prepare("PRAGMA table_info(session)")
        .map_err(|e| e.to_string())?;
    for name in columns
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
    {
        has_revert |= name.map_err(|e| e.to_string())? == "revert";
    }
    let session_query = if has_revert {
        "SELECT title, time_updated, revert FROM session WHERE id = ?1"
    } else {
        "SELECT title, time_updated, NULL FROM session WHERE id = ?1"
    };
    let mut info: Value = connection.query_row(
        session_query, [id],
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
    if immutable {
        let current = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if !companions_absent()
            || (
                current.len(),
                current.modified().map_err(|e| e.to_string())?,
            ) != fingerprint
        {
            return Err(
                "native database changed during history read; retry the history read".into(),
            );
        }
    }
    Ok(crate::build_opencode_snapshot_json(
        id,
        &info,
        &json!(messages),
        None,
    ))
}

fn read_claude(home: &Path, id: &str, provider: &str) -> Result<Value, String> {
    let path = crate::claude_snapshot::find_transcript(&home.join(".claude"), id)
        .ok_or("saved native session not found")?;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if metadata.len() > MAX_HISTORY_BYTES {
        return Err("native transcript exceeds history read limit".into());
    }
    let mut transcript = String::new();
    file.take(MAX_HISTORY_BYTES + 1)
        .read_to_string(&mut transcript)
        .map_err(|e| e.to_string())?;
    if transcript.len() as u64 > MAX_HISTORY_BYTES {
        return Err("native transcript exceeds history read limit".into());
    }
    let revision = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    Ok(crate::claude_snapshot::build_claude_snapshot_json(
        if provider == "kilroy" {
            "kilroy"
        } else {
            "freshclaude"
        },
        id,
        &transcript,
        revision,
        None,
    ))
}
