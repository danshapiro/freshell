//! Read a selected native transcript without creating a provider runtime.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{Read, Seek},
    path::Path,
};

#[path = "native_history_source.rs"]
mod source;
pub(crate) use source::{Records, Retention};
pub(crate) const RETAINED_TURN_BYTES: usize = MAX_HISTORY_BYTES as usize / 4;

pub const MAX_HISTORY_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) fn managed_provider_identity() -> Result<Option<(u32, u32)>, String> {
    match (
        std::env::var("FRESHELL_PROVIDER_RUN_AS_UID").ok(),
        std::env::var("FRESHELL_PROVIDER_RUN_AS_GID").ok(),
    ) {
        (None, None) => Ok(None),
        (Some(uid), Some(gid)) => {
            let identity = (
                uid.parse().map_err(|_| "invalid managed provider uid")?,
                gid.parse().map_err(|_| "invalid managed provider gid")?,
            );
            #[cfg(unix)]
            if identity == (unsafe { libc::geteuid() }, unsafe { libc::getegid() }) {
                return Ok(None);
            }
            Ok(Some(identity))
        }
        _ => Err("incomplete managed provider identity".into()),
    }
}

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

/// Optional live-display source; this does not grant ownership or live controls.
pub fn read_large_codex_display(
    codex_home: &Path,
    session_id: &str,
) -> Result<Option<Value>, String> {
    crate::codex::read_large_native_display(codex_home, session_id)
}

pub(crate) async fn large_codex_display(
    codex_home: &Path,
    session_id: &str,
) -> Result<Option<Value>, String> {
    let Some((uid, gid)) = managed_provider_identity()? else {
        let home = codex_home.to_owned();
        let id = session_id.to_owned();
        return tokio::task::spawn_blocking(move || read_large_codex_display(&home, &id))
            .await
            .map_err(|error| error.to_string())?;
    };
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new("/usr/bin/setpriv")
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
        .arg("native-history-only")
        .args(["--provider", "codex", "--provider-home"])
        .arg(std::env::var("HOME").map_err(|_| "managed provider HOME unavailable")?)
        .args(["--session-id", session_id, "--codex-home"])
        .arg(codex_home)
        .arg("--if-large")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(freshell_codex::app_server::SNAPSHOT_READ_TIMEOUT_MS),
        async {
            let mut bytes = Vec::new();
            child
                .stdout
                .take()
                .ok_or("native history worker has no stdout")?
                .take(MAX_HISTORY_BYTES + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "native history read failed")?;
            if bytes.len() as u64 > MAX_HISTORY_BYTES {
                return Err("native history response exceeds retained display budget");
            }
            if !child
                .wait()
                .await
                .map_err(|_| "native history worker wait failed")?
                .success()
            {
                return Err(
                    "provider UID native history worker could not read selected Codex history",
                );
            }
            serde_json::from_slice(&bytes).map_err(|_| "invalid native history worker response")
        },
    )
    .await;
    match result {
        Ok(Ok(snapshot)) => Ok(snapshot),
        failure => {
            let _ = child.kill().await;
            let reason = match failure {
                Ok(Err(reason)) => reason,
                Err(_) => "native history read timed out",
                Ok(Ok(_)) => unreachable!(),
            };
            tracing::warn!(
                event = "freshagent.codex.native_history_read_failed",
                session_id,
                provider_uid = uid,
                provider_gid = gid,
                reason
            );
            Err(reason.to_owned())
        }
    }
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
    pub(crate) omitted_items: usize,
    retention: Retention,
}

impl RetainedTurns {
    pub(crate) fn new(retention: &Retention) -> Self {
        Self {
            values: VecDeque::new(),
            bytes: 0,
            omitted: 0,
            omitted_items: 0,
            retention: retention.clone(),
        }
    }
    pub(crate) fn push(&mut self, mut value: Value) {
        let encoded = serde_json::to_vec(&value).expect("JSON value serializes");
        if encoded.len() > RETAINED_TURN_BYTES {
            // Use the same bounded JSON projection as native file reads. This
            // covers unknown display fields, raw mirrors and many small items.
            match source::bounded_value(std::io::Cursor::new(encoded), &self.retention) {
                Ok((projected, omitted)) => {
                    value = projected;
                    self.omitted_items += omitted;
                }
                Err(error) => {
                    tracing::warn!(event = "freshagent.native_history.display_projection_failed", reason = %error);
                    omit_large_bodies(&mut value, &self.retention);
                }
            }
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

/// Retain display history without changing the live owner's controls or state.
pub(crate) fn retain_snapshot_display(provider: &str, snapshot: &mut Value) {
    let retention = Retention::new();
    let mut omitted = 0;
    let mut omitted_items = 0;
    for key in ["turns", "rolledBackTurns"] {
        if let Some(turns) = snapshot.get_mut(key).and_then(Value::as_array_mut) {
            let mut retained = RetainedTurns::new(&retention);
            for turn in std::mem::take(turns) {
                retained.push(turn);
            }
            omitted += retained.omitted;
            omitted_items += retained.omitted_items;
            *turns = retained.values();
        }
    }
    let bodies = retention.finish(snapshot);
    let provider = if provider == "kilroy" {
        "claude"
    } else {
        provider
    };
    let old = &snapshot["extensions"][provider]["nativeHistoryRetention"];
    let omitted_turns = omitted + old["omittedNativeTurns"].as_u64().unwrap_or(0) as usize;
    let omitted_items = omitted_items + old["omittedItems"].as_u64().unwrap_or(0) as usize;
    let omitted_bodies = bodies + old["omittedBodies"].as_u64().unwrap_or(0) as usize;
    record_retention(
        provider,
        snapshot,
        omitted_turns,
        omitted_items,
        omitted_bodies,
    );
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
    record_retention(
        provider,
        snapshot,
        omitted_turns,
        omitted_items,
        omitted_bodies,
    );
    Ok(())
}

fn record_retention(
    provider: &str,
    snapshot: &mut Value,
    omitted_turns: usize,
    omitted_items: usize,
    omitted_bodies: usize,
) {
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
}

fn read_opencode(home: &Path, id: &str) -> Result<Value, String> {
    read_opencode_path(&home.join(".local/share/opencode/opencode.db"), id)
}

pub(crate) fn read_opencode_path(path: &Path, id: &str) -> Result<Value, String> {
    let companions_absent =
        || !path.with_extension("db-wal").exists() && !path.with_extension("db-shm").exists();
    // A clean WAL close removes its companions. SQLite otherwise needs a writable
    // directory even for READ_ONLY. Only the companion-free snapshot is immutable;
    // existing WAL uses SQLite's normal transaction so committed rows remain visible.
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
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
            path,
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
        let current = std::fs::metadata(path).map_err(|e| e.to_string())?;
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
    snapshot["extensions"]["opencode"]["nativeHistoryActivity"] = json!({
        "at":info["time"]["updated"],"source":"native_timestamp",
    });
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

/// A saved claude/kilroy transcript through the per-line projection only
/// (bounded retention, no cross-line folding; see the module docs of
/// `claude_projection`): compaction markers, command output, errors and
/// image placeholders match the live snapshot, while an `Agent` call stays a
/// plain tool row with its result and a background agent's completion
/// notice is not shown.
fn read_claude(home: &Path, id: &str, provider: &str) -> Result<Value, String> {
    let path = crate::claude_snapshot::find_transcript(&home.join(".claude"), id)
        .ok_or("saved native session not found")?;
    read_claude_path(
        &path,
        id,
        if provider == "kilroy" {
            "kilroy"
        } else {
            "freshclaude"
        },
        None,
    )
}

pub(crate) fn read_claude_path(
    path: &Path,
    id: &str,
    session_type: &str,
    rollback: Option<&crate::rollback_record::RollbackRecord>,
) -> Result<Value, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let extent = metadata.len();
    let retention = Retention::new();
    let source = Records::new(std::io::BufReader::new((&file).take(extent)), &retention);
    let mut turns = RetainedTurns::new(&retention);
    let mut ordinal = 0;
    let mut omitted_items = 0;
    let mut native_activity = None;
    let mut has_record = false;
    for record in source {
        let Some((record, omitted)) = record.map_err(|e| e.to_string())? else {
            continue;
        };
        has_record = true;
        if let Some(at) = freshell_sessions::time::parse_timestamp_ms(&record["timestamp"]) {
            native_activity = Some(native_activity.map_or(at, |prior: i64| prior.max(at)));
        }
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
    if !has_record && extent > 0 {
        // Preserve empty/new and valid partial JSONL sources, but do not claim
        // unreadable bytes are an available empty conversation. A valid prefix
        // already supplies readable history even if a crash interrupted its tail.
        file.rewind().map_err(|error| error.to_string())?;
        if let Err(error) = validate_utf8_text(file.take(extent)) {
            tracing::warn!(event = "freshagent.native_history.unreadable_claude_source",
                session_id = id, source_bytes = extent, reason = %error);
            return Err(format!("selected Claude transcript is unreadable: {error}"));
        }
    }
    let omitted = turns.omitted;
    omitted_items += turns.omitted_items;
    let turns = turns.values();
    let revision = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    let mut snapshot = crate::claude_snapshot::build_claude_snapshot_json(
        session_type,
        id,
        "",
        revision,
        rollback,
    );
    snapshot["latestTurnId"] = turns
        .last()
        .map(|turn| turn["turnId"].clone())
        .unwrap_or(Value::Null);
    snapshot["turns"] = json!(turns);
    snapshot["extensions"]["claude"]["nativeHistoryActivity"] = json!({
        "at":native_activity.unwrap_or(revision),
        "source":if native_activity.is_some(){"native_timestamp"}else{"source_modification"},
    });
    finish_retention(
        "claude",
        &mut snapshot,
        omitted,
        omitted_items,
        Some(&retention),
    )?;
    Ok(snapshot)
}

fn validate_utf8_text(mut source: impl Read) -> std::io::Result<()> {
    let mut bytes = [0; 64 * 1024];
    let mut pending = 0;
    loop {
        let read = match source.read(&mut bytes[pending..]) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let used = pending + read;
        match std::str::from_utf8(&bytes[..used]) {
            Ok(_) => pending = 0,
            Err(error) if read == 0 || error.error_len().is_some() => {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, error));
            }
            Err(error) => {
                pending = used - error.valid_up_to();
                bytes.copy_within(error.valid_up_to()..used, 0);
            }
        }
        if read == 0 {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_claude_source(bytes: &[u8]) -> Result<Value, String> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("saved-native.jsonl");
        std::fs::write(&path, bytes).unwrap();
        let result = read_claude_path(&path, "saved-native", "freshclaude", None);
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        result
    }

    #[test]
    fn streaming_claude_snapshot_rejects_wholly_unreadable_native_bytes() {
        for bytes in [
            vec![0xff, 0xfe],
            b"{\"type\":\"user\",\xff".to_vec(),
            vec![0xf0, 0x9f],
        ] {
            assert!(
                read_claude_source(&bytes).is_err(),
                "unreadable bytes must not become an available empty conversation"
            );
        }
    }

    #[test]
    fn streaming_claude_snapshot_keeps_empty_and_metadata_only_sources() {
        for bytes in [
            b"".as_slice(),
            b"\n \t\n",
            b"{\"type\":\"system\",\"subtype\":\"init\"}\n",
        ] {
            let snapshot = read_claude_source(bytes).unwrap();
            assert_eq!(snapshot["turns"], json!([]));
            assert_eq!(snapshot["threadId"], "saved-native");
        }
    }

    #[test]
    fn streaming_claude_snapshot_keeps_partial_utf8_sources_across_buffer_boundaries() {
        for character in ['é', '中', '🙂'] {
            let mut bytes = vec![b'"'];
            bytes.extend(std::iter::repeat_n(b'x', 64 * 1024 - 2));
            bytes.extend(character.to_string().repeat(4).as_bytes());
            let snapshot = read_claude_source(&bytes).unwrap();
            assert_eq!(snapshot["turns"], json!([]));
            bytes.pop();
            assert!(
                read_claude_source(&bytes).is_err(),
                "an incomplete UTF8 character with no readable record is unavailable"
            );
        }
    }

    #[test]
    fn streaming_claude_snapshot_preserves_complete_prefix_before_crash_tail() {
        let mut bytes = b"{\"type\":\"user\",\"uuid\":\"first-user\",\"message\":{\"role\":\"user\",\"content\":\"Saved prompt before interrupted append\"}}\n".to_vec();
        bytes.extend(b"{\"type\":\"assistant\",\"message\":\xff\xfe");
        let snapshot = read_claude_source(&bytes).unwrap();
        assert_eq!(snapshot["turns"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["turns"][0]["turnId"], "first-user");
        assert_eq!(
            snapshot["turns"][0]["items"][0]["text"],
            "Saved prompt before interrupted append"
        );
    }
}
