//! codex **durability / thread-id** handling — the id shapes the T2
//! `session.durable-id-shape` invariant grades, the rollout-filename → threadId extraction
//! (`providers/codex.ts:417-421`), and the sidecar ownership identifiers the `/proc` reaper
//! keys on (parity with `freshell-opencode`'s `OPENCODE_SIDECAR_OWNERSHIP_ENV`).
//!
//! Codex thread ids are **UUIDs and STABLE from create** — placeholder == durable, so NO
//! `freshAgent.session.materialized` event fires (`coding-cli.md §1c`; `codex-gptmini.json`
//! shapes `placeholderIdPattern == durableIdPattern`). The on-disk transcript is
//! `rollout-<ts>-<threadId>.jsonl` under `<CODEX_HOME>/sessions/<date-dirs>/`
//! (`codex-gptmini.json` provenance).

use std::path::Path;

use uuid::Uuid;

/// The env var that tags an owned `codex app-server` sidecar so the `/proc` reaper can
/// SIGTERM exactly our detached child and no other (`runtime.ts:494,1258`). The reaper
/// needle is `"{CODEX_SIDECAR_OWNERSHIP_ENV}={ownership_id}"`. Mirror of
/// `freshell-opencode`'s `OPENCODE_SIDECAR_OWNERSHIP_ENV`.
pub const CODEX_SIDECAR_OWNERSHIP_ENV: &str = "FRESHELL_CODEX_SIDECAR_ID";

/// `true` iff `value` is a bare UUID (8-4-4-4-12 hex) — the codex thread-id / durable-id
/// shape (`codex-gptmini.json` `placeholderIdPattern`/`durableIdPattern`). Case-insensitive
/// hex, matching the reference's `[0-9a-fA-F]` classes (`providers/codex.ts:419`).
pub fn is_codex_thread_id(value: &str) -> bool {
    matches_uuid_at(value.as_bytes(), 0) == Some(value.len())
}

/// The `/proc environ` reaper needle for an owned sidecar (`runtime.ts:494`).
pub fn ownership_needle(ownership_id: &str) -> String {
    format!("{CODEX_SIDECAR_OWNERSHIP_ENV}={ownership_id}")
}

/// Mint a fresh sidecar ownership id `codex-sidecar-<uuid>` (`ownershipIdFactory`,
/// `runtime.ts:924`).
pub fn mint_ownership_id() -> String {
    format!("codex-sidecar-{}", Uuid::new_v4())
}

/// The default server-instance id: `FRESHELL_SERVER_INSTANCE_ID` or `srv-<pid>`
/// (`runtime.ts:923`). Stamped into ownership metadata + durability records.
pub fn default_server_instance_id() -> String {
    std::env::var("FRESHELL_SERVER_INSTANCE_ID")
        .unwrap_or_else(|_| format!("srv-{}", std::process::id()))
}

// ── history mode (kata 1wxv Task 2, LBC-1) ─────────────────────────────────

/// The codex thread history mode. `thread/revert` (0.149.0 conversation
/// rollback) REFUSES legacy threads, so rollback capability is gated on the
/// thread being [`HistoryMode::Paginated`]. There is deliberately no `Legacy`
/// variant: "not paginated" (missing/unparseable durable meta, an explicit
/// `"legacy"` value) reads as `Option<HistoryMode>::None` at every consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryMode {
    Paginated,
}

impl HistoryMode {
    /// The `thread/start` wire value (`historyMode`).
    pub fn wire_name(&self) -> &'static str {
        match self {
            HistoryMode::Paginated => "paginated",
        }
    }

    /// Parse the rollout `session_meta.payload.history_mode` value. Only the
    /// exact durable `"paginated"` string upgrades a thread; anything else
    /// (missing key, non-string, unknown value) stays legacy.
    fn from_meta_value(value: Option<&serde_json::Value>) -> Option<HistoryMode> {
        match value.and_then(serde_json::Value::as_str) {
            Some("paginated") => Some(HistoryMode::Paginated),
            _ => None,
        }
    }
}

/// The `<CODEX_HOME|~/.codex>/sessions` root (same resolution as
/// `defaultCodexHome()`, `providers/codex.ts:25-27`). `None` when neither
/// `CODEX_HOME` nor `HOME` is set — there is no rollout tree to read.
fn codex_sessions_root() -> Option<std::path::PathBuf> {
    if let Ok(v) = std::env::var("CODEX_HOME") {
        if !v.is_empty() {
            return Some(std::path::PathBuf::from(v).join("sessions"));
        }
    }
    let home = std::env::var("HOME").ok().filter(|v| !v.is_empty())?;
    Some(
        std::path::PathBuf::from(home)
            .join(".codex")
            .join("sessions"),
    )
}

/// The first line of `path`, trimmed. Rollout session_meta is ALWAYS line 0
/// (the rollout writer emits it first; a file still in codex's
/// create→session_meta git-info gap has no readable first line yet and
/// answers `None`).
fn first_line(path: &Path) -> Option<String> {
    use std::io::{BufRead, Read};
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file).take(1024 * 1024);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let trimmed = first.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Parse a rollout `session_meta` first line into its payload. `None` for any
/// line that is not a `{"type":"session_meta","payload":{…}}` record.
fn session_meta_payload(line: &str) -> Option<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
        return None;
    }
    value.get("payload").cloned()
}

/// Locate the rollout owned by `thread_id` under `sessions_root`. The filename
/// containment is a cheap PREFILTER; ownership is proven by the first line
/// being a `session_meta` whose `payload.id`/`payload.session_id` equals the
/// thread id — substring matching alone is unsafe (rollouts embed foreign
/// uuids as fork/resume lineage; the codex_reconcile walk in freshell-ws uses
/// the same proof). Bounded recursive walk: the tree is
/// `sessions/YYYY/MM/DD/rollout-*.jsonl` (flat `<id>.jsonl` in tests).
fn locate_rollout(sessions_root: &Path, thread_id: &str) -> Option<std::path::PathBuf> {
    fn owns(path: &Path, thread_id: &str) -> bool {
        let Some(first) = first_line(path) else {
            return false;
        };
        let Some(payload) = session_meta_payload(&first) else {
            return false;
        };
        payload.get("id").and_then(serde_json::Value::as_str) == Some(thread_id)
            || payload
                .get("session_id")
                .and_then(serde_json::Value::as_str)
                == Some(thread_id)
    }
    fn walk(dir: &Path, thread_id: &str, depth: u8, hit: &mut Option<std::path::PathBuf>) {
        if depth > 5 || hit.is_some() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if hit.is_some() {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(&path, thread_id, depth + 1, hit);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(".jsonl") && n.contains(thread_id))
                .unwrap_or(false)
                && owns(&path, thread_id)
            {
                *hit = Some(path);
            }
        }
    }
    let mut hit = None;
    walk(sessions_root, thread_id, 0, &mut hit);
    hit
}

/// The thread's DURABLE history mode, read from its rollout's persisted
/// `session_meta.history_mode` (kata 1wxv Task 2, r3: validator-C proved the
/// mode persists there, and `thread/resume` takes no mode param — the durable
/// rollout meta is the ONLY source of truth; the app-server exposes no live
/// read-back). `Some(Paginated)` only when the meta says so; a missing rollout,
/// a missing/unparseable mode, or an IO/parse failure all answer `None` ⇒
/// legacy (capability never over-advertised: `undo:false`).
pub fn read_rollout_history_mode(thread_id: &str) -> Option<HistoryMode> {
    let root = codex_sessions_root()?;
    let path = locate_rollout(&root, thread_id)?;
    let line = first_line(&path)?;
    let payload = session_meta_payload(&line)?;
    HistoryMode::from_meta_value(payload.get("history_mode"))
}

/// `extractSessionIdFromFilename(filePath)` (`providers/codex.ts:417-421`): the UUID embedded
/// in a `rollout-<ts>-<threadId>.jsonl` basename, else the basename (minus `.jsonl`) verbatim.
pub fn extract_session_id_from_filename(file_path: &str) -> String {
    let base = Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_path);
    let base = base.strip_suffix(".jsonl").unwrap_or(base);
    match find_uuid(base) {
        Some(uuid) => uuid,
        None => base.to_string(),
    }
}

// ── UUID matching (no regex crate; hand-rolled 8-4-4-4-12 hex) ──────────────────────────

fn is_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b.to_ascii_lowercase())
}

/// If `bytes[start..]` begins with a UUID (8-4-4-4-12 hex), return the index just past it.
fn matches_uuid_at(bytes: &[u8], start: usize) -> Option<usize> {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let mut i = start;
    for (g, &len) in GROUPS.iter().enumerate() {
        if g > 0 {
            if bytes.get(i) != Some(&b'-') {
                return None;
            }
            i += 1;
        }
        for _ in 0..len {
            match bytes.get(i) {
                Some(&b) if is_hex(b) => i += 1,
                _ => return None,
            }
        }
    }
    Some(i)
}

/// The first UUID-shaped substring of `text`, if any (`String.match(uuidRegex)`).
fn find_uuid(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if let Some(end) = matches_uuid_at(bytes, start) {
            return Some(text[start..end].to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_thread_id_shape_is_a_bare_uuid() {
        // The exact codex-gptmini.json placeholder/durable pattern.
        assert!(is_codex_thread_id("019810de-1e5f-7db3-9c47-1c2a3b4c5d6e"));
        assert!(is_codex_thread_id("ABCDEF01-2345-6789-abcd-ef0123456789")); // case-insensitive
                                                                             // Rejections: too short, extra chars, non-hex, wrong grouping.
        assert!(!is_codex_thread_id("thread-new-1"));
        assert!(!is_codex_thread_id("freshopencode-abc"));
        assert!(!is_codex_thread_id("019810de-1e5f-7db3-9c47-1c2a3b4c5d6")); // 11 in last group
        assert!(!is_codex_thread_id("019810de-1e5f-7db3-9c47-1c2a3b4c5d6ef")); // 13 in last group
        assert!(!is_codex_thread_id("g19810de-1e5f-7db3-9c47-1c2a3b4c5d6e")); // non-hex
        assert!(!is_codex_thread_id(" 019810de-1e5f-7db3-9c47-1c2a3b4c5d6e")); // leading space
    }

    #[test]
    fn rollout_filename_yields_embedded_thread_uuid() {
        // rollout-<ts>-<threadId>.jsonl → the UUID (codex-gptmini.json transcript layout).
        assert_eq!(
            extract_session_id_from_filename(
                "/codex/sessions/2026/07/05/rollout-2026-07-05T06-25-37-019810de-1e5f-7db3-9c47-1c2a3b4c5d6e.jsonl"
            ),
            "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e"
        );
        // No UUID → the basename verbatim (reference fallback).
        assert_eq!(
            extract_session_id_from_filename("/x/session-activity.jsonl"),
            "session-activity"
        );
        assert_eq!(
            extract_session_id_from_filename("rollout-plain.jsonl"),
            "rollout-plain"
        );
    }

    #[test]
    fn ownership_id_and_needle_shapes() {
        let id = mint_ownership_id();
        assert!(id.starts_with("codex-sidecar-"));
        assert!(
            is_codex_thread_id(id.trim_start_matches("codex-sidecar-")),
            "the tail is a UUID"
        );
        assert_eq!(
            ownership_needle("codex-sidecar-abc"),
            "FRESHELL_CODEX_SIDECAR_ID=codex-sidecar-abc"
        );
    }

    #[test]
    fn server_instance_id_defaults_to_srv_pid_without_env() {
        // No env override → srv-<pid> shape (we cannot mutate global env safely in parallel
        // tests, so only assert the default branch shape when the var is absent).
        if std::env::var("FRESHELL_SERVER_INSTANCE_ID").is_err() {
            let id = default_server_instance_id();
            assert!(id.starts_with("srv-"), "got {id}");
        }
    }

    // ── history mode (kata 1wxv Task 2) ────────────────────────────────────

    fn write_rollout(root: &Path, dir: &str, name: &str, payload: &str) {
        let dir = root.join(dir);
        std::fs::create_dir_all(&dir).expect("sessions dir");
        std::fs::write(
            dir.join(name),
            format!("{{\"timestamp\":\"2026-08-23T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{{payload}}}}}\n"),
        )
        .expect("write rollout");
    }

    #[test]
    fn history_mode_wire_and_meta_parse() {
        assert_eq!(HistoryMode::Paginated.wire_name(), "paginated");
        assert_eq!(
            HistoryMode::from_meta_value(Some(&serde_json::json!("paginated"))),
            Some(HistoryMode::Paginated)
        );
        // Missing key, wrong type, unknown value, explicit legacy → all legacy (None).
        assert_eq!(HistoryMode::from_meta_value(None), None);
        assert_eq!(
            HistoryMode::from_meta_value(Some(&serde_json::json!(42))),
            None
        );
        assert_eq!(
            HistoryMode::from_meta_value(Some(&serde_json::json!("legacy"))),
            None
        );
        assert_eq!(
            HistoryMode::from_meta_value(Some(&serde_json::json!("Paginated"))),
            None,
            "the durable value is matched exactly (no case laundering)"
        );
    }

    #[test]
    fn locate_rollout_proves_ownership_by_the_session_meta_first_line() {
        let root = tempfile::tempdir().expect("tempdir");
        let tid = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";
        // The owned rollout, nested in the dated tree.
        write_rollout(
            root.path(),
            "2026/08/23",
            &format!("rollout-2026-08-23T00-00-00-{tid}.jsonl"),
            &format!("\"id\":\"{tid}\",\"history_mode\":\"paginated\""),
        );
        // A FOREIGN rollout whose filename embeds the searched id via lineage —
        // the prefilter hits, the ownership proof must reject it.
        write_rollout(
            root.path(),
            "2026/08/23",
            "rollout-2026-08-23T01-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
            &format!(
                "\"id\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\",\"forked_from_id\":\"{tid}\""
            ),
        );
        // A filename-match decoy whose session_meta names a DIFFERENT id (the
        // documented-unsafe substring case): a copy of tid's rollout under a
        // mangled name.
        write_rollout(
            root.path(),
            "",
            &format!("flat-{tid}.jsonl"),
            "\"id\":\"ffffffff-0000-4111-8222-333333333333\"",
        );

        // The walk must find SOME owned file (the dated-tree one) even though the
        // flat foreign decoy exists at the root...
        let hit = locate_rollout(root.path(), tid).expect("owned rollout found");
        assert!(
            hit.to_string_lossy().contains("2026/08/23"),
            "the dated-tree owned rollout wins: {hit:?}"
        );
        // ...and must skip both decoys when the owned one is absent.
        std::fs::remove_file(&hit).expect("remove owned");
        assert_eq!(locate_rollout(root.path(), tid), None);
    }

    #[test]
    fn read_rollout_history_mode_parses_the_meta_of_an_explicit_root() {
        let root = tempfile::tempdir().expect("tempdir");
        let tid = "thr-paged";
        write_rollout(
            root.path(),
            "2026/08/23",
            "rollout-2026-08-23T00-00-00-thr-paged.jsonl",
            "\"id\":\"thr-paged\",\"history_mode\":\"paginated\"",
        );
        let hit = locate_rollout(root.path(), tid).expect("found");
        let line = first_line(&hit).expect("first line");
        let payload = session_meta_payload(&line).expect("payload");
        assert_eq!(
            HistoryMode::from_meta_value(payload.get("history_mode")),
            Some(HistoryMode::Paginated)
        );
        write_rollout(
            root.path(),
            "2026/08/24",
            "rollout-2026-08-24T00-00-00-thr-legacy.jsonl",
            "\"id\":\"thr-legacy\"",
        );
        let hit = locate_rollout(root.path(), "thr-legacy").expect("found");
        let line = first_line(&hit).expect("first line");
        let payload = session_meta_payload(&line).expect("payload");
        assert_eq!(
            HistoryMode::from_meta_value(payload.get("history_mode")),
            None,
            "a missing durable mode stamps legacy (undo:false)"
        );
    }
}
