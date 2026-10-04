//! Read a selected native transcript without creating a provider runtime.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::VecDeque, io::Read, path::Path};

#[path = "native_history_source.rs"]
mod source;
pub(crate) use source::{Records, Retention};
pub(crate) const RETAINED_TURN_BYTES: usize = MAX_HISTORY_BYTES as usize / 4;

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
    finish_retention(provider, &mut snapshot, 0, 0, None)?;
    Ok(snapshot)
}

/// A display window, measured in serialized bytes, preserving original ordinals.
pub(crate) struct RetainedTurns {
    values: VecDeque<(Value, usize)>,
    bytes: usize,
    pub(crate) omitted: usize,
    retention: Retention,
}

impl RetainedTurns {
    pub(crate) fn new(retention: &Retention) -> Self {
        Self {
            values: VecDeque::new(),
            bytes: 0,
            omitted: 0,
            retention: retention.clone(),
        }
    }
    pub(crate) fn push(&mut self, mut value: Value) {
        if serde_json::to_vec(&value).unwrap().len() > RETAINED_TURN_BYTES {
            omit_large_bodies(&mut value, &self.retention);
        }
        let size = serde_json::to_vec(&value)
            .expect("JSON value serializes")
            .len();
        self.bytes += size;
        self.values.push_back((value, size));
        while self.bytes > RETAINED_TURN_BYTES && self.values.len() > 1 {
            self.bytes -= self.values.pop_front().unwrap().1;
            self.omitted += 1;
        }
    }
    pub(crate) fn values(self) -> Vec<Value> {
        self.values.into_iter().map(|(value, _)| value).collect()
    }
}

/// Preserve the item and native control metadata while omitting a display body.
/// Used when a single task/message is larger than the retained window.
pub(crate) fn omit_large_bodies(value: &mut Value, retention: &Retention) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "text"
                        | "thinking"
                        | "content"
                        | "input"
                        | "output"
                        | "arguments"
                        | "result"
                        | "aggregatedOutput"
                        | "contentItems"
                ) {
                    compact_body(value, retention);
                } else {
                    omit_large_bodies(value, retention);
                }
            }
        }
        Value::Array(array) => {
            for value in array {
                omit_large_bodies(value, retention);
            }
        }
        _ => {}
    }
}

fn compact_body(value: &mut Value, retention: &Retention) {
    let limit = RETAINED_TURN_BYTES / 1024;
    match value {
        Value::String(text) if text.len() > limit => {
            let mut start = text.len() - limit;
            while !text.is_char_boundary(start) {
                start += 1;
            }
            *text = format!("{}\n{}", retention.marker("body"), &text[start..]);
        }
        Value::Array(array) => {
            for value in array {
                if value.is_object() {
                    // A content block owns native type/link metadata. Compact
                    // its display fields without replacing the block itself.
                    omit_large_bodies(value, retention);
                } else {
                    compact_body(value, retention);
                }
            }
        }
        // Structured tool input/result bodies can contain many small fields.
        // Keep the established omission policy for these bodies; the containing
        // call and its native identity remain available.
        Value::Object(_) if serde_json::to_vec(value).unwrap().len() > limit => {
            *value = json!({"Retained history":retention.marker("body")});
        }
        _ => {}
    }
}

pub(crate) fn finish_retention(
    provider: &str,
    snapshot: &mut Value,
    omitted_turns: usize,
    omitted_items: usize,
    retention: Option<&Retention>,
) -> Result<(), String> {
    let provider = if provider == "kilroy" {
        "claude"
    } else {
        provider
    };
    let old = &snapshot["extensions"][provider]["nativeHistoryRetention"];
    let mut omitted_turns =
        omitted_turns + old["omittedNativeTurns"].as_u64().unwrap_or(0) as usize;
    let omitted_items = omitted_items + old["omittedItems"].as_u64().unwrap_or(0) as usize;
    let omitted_bodies = old["omittedBodies"].as_u64().unwrap_or(0) as usize
        + retention
            .map(|retention| retention.finish(snapshot))
            .unwrap_or(0);
    // Reserve framing and retention metadata before the helper's stdout boundary.
    while serde_json::to_vec(snapshot)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_HISTORY_BYTES as usize - 4096
    {
        let key = if snapshot["rolledBackTurns"]
            .as_array()
            .is_some_and(|turns| turns.len() > 1)
        {
            "rolledBackTurns"
        } else {
            "turns"
        };
        let turns = snapshot[key]
            .as_array_mut()
            .ok_or("native history has no retained display turns")?;
        if turns.len() <= 1 {
            return Err("native history metadata exceeds display budget".into());
        }
        let ordinal = turns[0]["ordinal"].clone();
        let native_id = turns[0]["turnId"].as_str().unwrap_or("").to_owned();
        let native_id = native_id
            .rsplit_once(":row-")
            .filter(|(_, row)| row.parse::<usize>().is_ok())
            .map(|(id, _)| id.to_owned())
            .unwrap_or(native_id);
        let before = turns.len();
        if provider == "codex" {
            turns.retain(|turn| {
                let id = turn["turnId"].as_str().unwrap_or("");
                id != native_id
                    && !id
                        .strip_prefix(&native_id)
                        .is_some_and(|suffix| suffix.starts_with(":row-"))
            });
        } else {
            turns.retain(|turn| turn["ordinal"] != ordinal);
        }
        omitted_turns += usize::from(turns.len() != before);
    }
    if omitted_turns + omitted_items + omitted_bodies > 0 {
        snapshot["extensions"][provider]["nativeHistoryRetention"] = json!({
            "partial":true, "omittedNativeTurns":omitted_turns, "omittedItems":omitted_items,
            "omittedBodies":omitted_bodies,
            "firstTurnId":snapshot["turns"].as_array().and_then(|turns| turns.first()).map(|turn| turn["turnId"].clone()),
            "lastTurnId":snapshot["turns"].as_array().and_then(|turns| turns.last()).map(|turn| turn["turnId"].clone()),
        });
        tracing::info!(
            provider,
            omitted_turns,
            omitted_items,
            omitted_bodies,
            "freshagent.native_history.retained_window"
        );
    }
    Ok(())
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
    let retention = Retention::new();
    let mut active = RetainedTurns::new(&retention);
    let mut rolled_back = RetainedTurns::new(&retention);
    let mut omitted_parts = 0;
    let pointer = info.pointer("/revert/messageID").and_then(Value::as_str);
    let mut after_revert = false;
    let mut statement = connection
        .prepare("SELECT id FROM message WHERE session_id = ?1 ORDER BY time_created, id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for (ordinal, row) in rows.enumerate() {
        let message_id = row.map_err(|e| e.to_string())?;
        after_revert |= pointer == Some(message_id.as_str());
        let (mut message, mut source_omissions) =
            read_sql_json(&connection, "message", &message_id, &retention)?;
        message["id"] = json!(message_id);
        let mut parts = RetainedTurns::new(&retention);
        let mut statement = connection.prepare("SELECT id FROM part WHERE session_id = ?1 AND message_id = ?2 ORDER BY time_created, id").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([id, &message_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let part_id = row.map_err(|e| e.to_string())?;
            let (mut part, omitted) = read_sql_json(&connection, "part", &part_id, &retention)?;
            source_omissions += omitted;
            part["id"] = json!(part_id);
            parts.push(part);
        }
        omitted_parts += parts.omitted;
        let message = json!({"info":message,"parts":parts.values()});
        if let Some(mut turn) = crate::opencode_message_turn_json(&message, ordinal) {
            omitted_parts += source_omissions;
            if after_revert {
                turn["rolledBack"] = json!(true);
                turn["restorable"] = json!(false);
                rolled_back.push(turn);
            } else {
                active.push(turn);
            }
        }
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
    let omitted = active.omitted + rolled_back.omitted;
    let active = active.values();
    let rolled_back = rolled_back.values();
    let mut snapshot = crate::build_opencode_snapshot_json(id, &info, &json!([]), None);
    snapshot["latestTurnId"] = active
        .last()
        .map(|turn| turn["turnId"].clone())
        .unwrap_or(Value::Null);
    snapshot["turns"] = json!(active);
    if !rolled_back.is_empty() {
        snapshot["rolledBackTurns"] = json!(rolled_back);
    }
    finish_retention(
        "opencode",
        &mut snapshot,
        omitted,
        omitted_parts,
        Some(&retention),
    )?;
    Ok(snapshot)
}

/// SQLite TEXT can itself be huge; read exact UTF-8 bytes in chunks inside the
/// same read transaction instead of allocating an entire row before clipping.
fn read_sql_json(
    connection: &Connection,
    table: &str,
    id: &str,
    retention: &Retention,
) -> Result<(Value, usize), String> {
    let query = if table == "message" {
        "SELECT rowid FROM message WHERE id=?1"
    } else {
        "SELECT rowid FROM part WHERE id=?1"
    };
    let rowid = connection
        .query_row(query, [id], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    let blob = connection
        .blob_open(rusqlite::DatabaseName::Main, table, "data", rowid, true)
        .map_err(|e| e.to_string())?;
    source::bounded_value(
        std::io::BufReader::with_capacity(64 * 1024, blob),
        retention,
    )
    .map_err(|e| e.to_string())
}

fn read_claude(home: &Path, id: &str, provider: &str) -> Result<Value, String> {
    let path = crate::claude_snapshot::find_transcript(&home.join(".claude"), id)
        .ok_or("saved native session not found")?;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let extent = metadata.len();
    let retention = Retention::new();
    let source = Records::new(std::io::BufReader::new(file.take(extent)), &retention);
    let mut turns = RetainedTurns::new(&retention);
    let mut ordinal = 0;
    let mut omitted_items = 0;
    for record in source {
        let Some((record, omitted)) = record.map_err(|e| e.to_string())? else {
            continue;
        };
        if let Some(turn) = crate::claude_snapshot::parse_transcript_turn_indexed(
            &record,
            id,
            ordinal,
            Some(&retention.index_key),
        ) {
            omitted_items += omitted;
            turns.push(turn);
            ordinal += 1;
        }
    }
    let omitted = turns.omitted;
    let turns = turns.values();
    let revision = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    let mut snapshot = crate::claude_snapshot::build_claude_snapshot_json(
        if provider == "kilroy" {
            "kilroy"
        } else {
            "freshclaude"
        },
        id,
        "",
        revision,
        None,
    );
    snapshot["latestTurnId"] = turns
        .last()
        .map(|turn| turn["turnId"].clone())
        .unwrap_or(Value::Null);
    snapshot["turns"] = json!(turns);
    finish_retention(
        provider,
        &mut snapshot,
        omitted,
        omitted_items,
        Some(&retention),
    )?;
    Ok(snapshot)
}
