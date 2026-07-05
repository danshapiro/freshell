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
//!
//! The **immutable-candidate** rule from the durability store
//! (`durability-store.ts`, `coding-cli.md §4c`) is modeled by [`DurabilityCandidate`]: once a
//! `{ candidateThreadId, rolloutPath }` is set it cannot change.

use std::path::{Path, PathBuf};

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
    std::env::var("FRESHELL_SERVER_INSTANCE_ID").unwrap_or_else(|_| format!("srv-{}", std::process::id()))
}

/// `defaultCodexDurabilityStoreDir()` (`durability-store.ts:24-27`):
/// `FRESHELL_CODEX_DURABILITY_DIR` or `<home>/.freshell/codex-durability`.
pub fn default_durability_store_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FRESHELL_CODEX_DURABILITY_DIR") {
        return PathBuf::from(dir);
    }
    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".freshell").join("codex-durability")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
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

/// The immutable `{ candidateThreadId, rolloutPath }` a durability record pins for a terminal
/// (`durability-store.ts:95-102`; `coding-cli.md §4c`). Once set it cannot be reassigned to a
/// different value — a re-set with the SAME value is idempotent, a DIFFERENT value is an error.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DurabilityCandidate {
    candidate_thread_id: Option<String>,
    rollout_path: Option<String>,
}

/// Raised when a durability candidate would be mutated after it was pinned
/// (the reference's immutability guard, `durability-store.ts:95-102`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateImmutableError {
    pub field: &'static str,
    pub existing: String,
    pub attempted: String,
}

impl std::fmt::Display for CandidateImmutableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Codex durability {} is immutable once set (have {:?}, refused {:?}).",
            self.field, self.existing, self.attempted
        )
    }
}

impl std::error::Error for CandidateImmutableError {}

impl DurabilityCandidate {
    pub fn candidate_thread_id(&self) -> Option<&str> {
        self.candidate_thread_id.as_deref()
    }

    pub fn rollout_path(&self) -> Option<&str> {
        self.rollout_path.as_deref()
    }

    /// Pin the `{ candidateThreadId, rolloutPath }`. Idempotent for an identical re-set; an
    /// attempt to change an already-pinned field yields [`CandidateImmutableError`].
    pub fn set(&mut self, candidate_thread_id: &str, rollout_path: &str) -> Result<(), CandidateImmutableError> {
        if let Some(existing) = &self.candidate_thread_id {
            if existing != candidate_thread_id {
                return Err(CandidateImmutableError {
                    field: "candidateThreadId",
                    existing: existing.clone(),
                    attempted: candidate_thread_id.to_string(),
                });
            }
        }
        if let Some(existing) = &self.rollout_path {
            if existing != rollout_path {
                return Err(CandidateImmutableError {
                    field: "rolloutPath",
                    existing: existing.clone(),
                    attempted: rollout_path.to_string(),
                });
            }
        }
        self.candidate_thread_id = Some(candidate_thread_id.to_string());
        self.rollout_path = Some(rollout_path.to_string());
        Ok(())
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
        assert_eq!(extract_session_id_from_filename("/x/session-activity.jsonl"), "session-activity");
        assert_eq!(extract_session_id_from_filename("rollout-plain.jsonl"), "rollout-plain");
    }

    #[test]
    fn ownership_id_and_needle_shapes() {
        let id = mint_ownership_id();
        assert!(id.starts_with("codex-sidecar-"));
        assert!(is_codex_thread_id(id.trim_start_matches("codex-sidecar-")), "the tail is a UUID");
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

    #[test]
    fn durability_candidate_is_immutable_once_set() {
        let mut candidate = DurabilityCandidate::default();
        assert_eq!(candidate.candidate_thread_id(), None);
        candidate.set("thread-a", "/rollouts/a.jsonl").expect("first set");
        assert_eq!(candidate.candidate_thread_id(), Some("thread-a"));
        assert_eq!(candidate.rollout_path(), Some("/rollouts/a.jsonl"));
        // Idempotent re-set with the same values is allowed.
        candidate.set("thread-a", "/rollouts/a.jsonl").expect("idempotent re-set");
        // A different thread id is refused.
        let err = candidate.set("thread-b", "/rollouts/a.jsonl").unwrap_err();
        assert_eq!(err.field, "candidateThreadId");
        // A different rollout path is refused.
        let err = candidate.set("thread-a", "/rollouts/b.jsonl").unwrap_err();
        assert_eq!(err.field, "rolloutPath");
        // The original values are intact after the refusals.
        assert_eq!(candidate.candidate_thread_id(), Some("thread-a"));
        assert_eq!(candidate.rollout_path(), Some("/rollouts/a.jsonl"));
    }
}
