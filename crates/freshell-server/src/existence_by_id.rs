//! By-id disk locators for the resume-validation feature (plan Task 3):
//! amplifier session-dir scan + gate-safe codex rollout walk, consumed by
//! [`crate::existence::IndexExistenceProbe`]'s warm-Absent adjudication and
//! cold-index coverage. New focused file (not appended to `existence.rs`,
//! which is already large); `existence.rs` re-exports everything here so the
//! probe's public surface stays `existence::*`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

/// By-id disk answer for the amplifier/codex fallbacks (mirrors
/// `OpencodeDbAnswer`'s shape). `Unreadable` is LOAD-BEARING: the probe maps
/// it to `Unknown`, NEVER `Absent` — only positive absence (store readable,
/// session definitively absent) may answer `Absent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByIdAnswer {
    Present,
    Absent,
    Unreadable,
}

/// Injected by-id amplifier session-dir check (kata 09v1 pattern: the probe
/// must agree with the attach arm — `amplifier resume <id>` finds the dir
/// regardless of index state). A closure keeps the probe unit-testable;
/// precedent: `ClaudeTranscriptLocator`/`OpencodeSessionLocator`.
pub type AmplifierSessionLocator = Arc<dyn Fn(&str) -> ByIdAnswer + Send + Sync>;

/// Injected by-id codex rollout check (same pattern). Warm-Absent
/// adjudication ONLY — the walk is ~1s on a real store, so the probe never
/// runs it on the cold path (AD-4).
pub type CodexRolloutExistenceLocator = Arc<dyn Fn(&str) -> ByIdAnswer + Send + Sync>;

/// Production amplifier locator: the read-only all-slugs scan of Task 2
/// (`freshell_sessions::amplifier_stub::session_on_disk` — errors-seen
/// accumulator, never `.is_dir()`-adjudicated).
pub fn amplifier_dir_locator(amplifier_home: PathBuf) -> AmplifierSessionLocator {
    Arc::new(move |session_id: &str| {
        match freshell_sessions::amplifier_stub::session_on_disk(&amplifier_home, session_id) {
            freshell_sessions::amplifier_stub::AmplifierSessionAnswer::Present => {
                ByIdAnswer::Present
            }
            freshell_sessions::amplifier_stub::AmplifierSessionAnswer::Absent => ByIdAnswer::Absent,
            freshell_sessions::amplifier_stub::AmplifierSessionAnswer::Unreadable => {
                ByIdAnswer::Unreadable
            }
        }
    })
}

/// Gate-safe tri-state codex rollout walk (resume-validation feature).
/// Deliberately a NEW walk, NOT a reuse of the fail-soft
/// `freshell_ws::codex_reconcile::locate_codex_rollout` — that helper
/// silently converts per-entry IO errors into `None`, which the gate would
/// read as positive absence (six false-Absent reproductions in V3).
/// Errors-seen accumulator: `Present` short-circuits; a walk that completes
/// having seen ANY per-entry error and no hit answers `Unreadable`.
pub fn codex_rollout_on_disk(sessions_root: &Path, session_id: &str) -> ByIdAnswer {
    // Root readability is established by read_dir itself: NotFound (parent
    // readable) => Absent (AD-1); any other error => Unreadable. NOTE:
    // `fs::metadata(root)` is NOT sufficient — it tests existence, not
    // readability (a mode-111 root passes metadata but fails read_dir; V3 E3).
    let mut stack = vec![sessions_root.to_path_buf()];
    let mut saw_error = false;
    let mut first_level = true;
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) if first_level && err.kind() == std::io::ErrorKind::NotFound => {
                return ByIdAnswer::Absent;
            }
            Err(_) if first_level => return ByIdAnswer::Unreadable,
            Err(_) => {
                saw_error = true; // unreadable subtree below the root — may hide the rollout
                continue;
            }
        };
        first_level = false;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    saw_error = true; // dropped dir entry (EIO, network fs) — cannot rule out
                    continue;
                }
            };
            let path = entry.path();
            // Never `.is_dir()` — false on EACCES (V3 E6).
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_dir() => stack.push(path),
                Ok(_) => {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    // Filename prefilter: id-in-name (verified convention,
                    // V2: 4459/4459 real rollouts + codex source constructs
                    // the name from the id) — accept both `.jsonl` and
                    // `.jsonl.zst` (future codex rollout compression, V2).
                    if name.contains(session_id)
                        && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
                    {
                        match first_line_owns_tri(&path, session_id) {
                            Ok(true) => return ByIdAnswer::Present,
                            Ok(false) => {} // valid read, id differs — keep walking
                            Err(()) => saw_error = true,
                        }
                    }
                }
                Err(_) => saw_error = true,
            }
        }
    }
    if saw_error {
        ByIdAnswer::Unreadable
    } else {
        ByIdAnswer::Absent
    }
}

/// Tri-state first-line ownership proof: `Ok(true)` iff the first line is a
/// `session_meta` whose `payload.id` equals `session_id` (mirror of
/// `codex_reconcile.rs`'s `first_line_owns`), `Ok(false)` for a VALID read
/// whose id differs (a genuine non-owner), `Err(())` for any open/read/
/// decode failure on a candidate (incl. an undecodable `.jsonl.zst`) — an
/// error must count toward `saw_error`, never as "not the owner".
fn first_line_owns_tri(path: &Path, session_id: &str) -> Result<bool, ()> {
    use std::io::{BufRead, Read};
    let file = std::fs::File::open(path).map_err(|_| ())?;
    let mut reader = std::io::BufReader::new(file).take(1024 * 1024);
    let mut first = String::new();
    reader.read_line(&mut first).map_err(|_| ())?;
    let value = serde_json::from_str::<serde_json::Value>(first.trim()).map_err(|_| ())?;
    Ok(value.get("type").and_then(|t| t.as_str()) == Some("session_meta")
        && value
            .get("payload")
            .and_then(|p| p.get("id"))
            .and_then(|i| i.as_str())
            == Some(session_id))
}

/// Production codex locator: wraps [`codex_rollout_on_disk`] over the same
/// sessions root the resume-time locator walks.
pub fn codex_rollout_existence_locator(sessions_root: PathBuf) -> CodexRolloutExistenceLocator {
    Arc::new(move |session_id: &str| codex_rollout_on_disk(&sessions_root, session_id))
}
