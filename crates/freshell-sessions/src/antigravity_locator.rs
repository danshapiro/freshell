//! Server-side antigravity terminal-pane conversation locator (antigravity
//! plan Task 6).
//!
//! Sibling of `codex_locator` (same module shape: arm at create, a
//! submit-anchored evaluation window, a `tick()` the ws association sweep
//! drives on the blocking pool). Substrate: the antigravity CLI persists
//! ONE transcript per conversation under
//! `<antigravity_home>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
//! (the `AntigravityLayout` root). A new conversation is a NEW directory,
//! and an in-CLI `/resume <existing id>` (Google's documented conversation
//! switch) APPENDS the user's next prompt to the EXISTING conversation's
//! transcript as its LATEST user record — so ONE evidence rule covers BOTH
//! first-bind and rebind, with no separate fork-watch lane:
//!
//! A tick considers ONLY transcripts whose
//! - ownership record (`session_start`) carries a `conversationId` whose
//!   `workspacePaths` CONTAIN the pane's cwd (normalized), and whose
//! - LATEST user-authored record (`user_message`) text EQUALS the pane's
//!   captured submit line (normalized, bounded comparison), and whose
//! - MATCHING user record was written AT/AFTER that submit (recency is
//!   proven by the matching record's OWN `at` — a later record of
//!   another type, e.g. an assistant record still streaming after the
//!   submit, never vouches for a user record written before it; a
//!   transcript whose matching record predates the submit can never
//!   match, which is what rejects re-typed old prompts and dead-launch
//!   late writes alike; unprovable timestamps fail toward refusal).
//!
//! Outcomes per tick per pane: exactly one matching candidate == current id
//! ⇒ no-op (the ws association decides; the locator has no current-id
//! state); exactly one with a different id ⇒ first-bind OR rebind (again
//! the association's call — the SAME rule, not a separate mechanism);
//! more than one ⇒ REFUSE all and warn `antigravity_association_refused
//! {reason:"ambiguous"}` — never a guess. Refusal never disarms: a later
//! solo submit re-opens the window and re-evaluates.
//!
//! // Stage-1 candidate contract: the transcript PATH and the hook inputs
//! (`conversationId`, `workspacePaths`, `transcriptPath`) are
//! documented+probe-validated facts; the on-disk RECORD SCHEMA this module
//! reads (`session_start` ownership record; `user_message`/other records
//! with `at` timestamps) is validated ONLY against the committed fixtures
//! (`test/fixtures/coding-cli/antigravity/*.sanitized.jsonl`, pinned by
//! `tests/antigravity_fixture_parity.rs`) — the A2 named blocker. No
//! capability flag or recovery claim may be enabled on this candidate
//! evidence.
//!
//! Deliberate deviations from the codex locator, with rationale:
//! - NO file-set (known-files) baseline: codex's candidates are a
//!   snapshot DIFFERENCE (a new rollout file is identity evidence by
//!   itself), while antigravity's candidates are CONTENT-matched across
//!   every transcript in the root — the pane's own conversation is proved
//!   by the prompt text it just submitted, not by the file being new. The
//!   matching-record recency rule replaces the baseline: a transcript
//!   whose matching user record predates the submit can never match.
//! - NO separate fork lane: codex needs `watch_fork`/`tick_forks` because
//!   its first-bind rule (new file in cwd) cannot see an in-CLI switch;
//!   antigravity's unified rule catches BOTH the fresh conversation and
//!   the `/resume` switch with the same per-submit window.
//! - RE-OPEN ON EVERY ENTER: a new `note_submit` REPLACES an in-flight
//!   window (the latest Enter is the live prompt — the transcript's
//!   latest user record moves to it immediately), where codex keeps the
//!   first Enter's window. With content matching, holding an older
//!   captured line could only ever mismatch.
//! - mtime PREFILTER (never authoritative): a transcript whose file mtime
//!   is older than `submit_at - 2 s` cannot have a record written at/after
//!   the submit, so its head/tail probe is skipped; an mtime error or a
//!   coarse-grained clock falls through to the probe (conservative).
//! - Bounded reads: the ownership record is read from a 64 KiB head window
//!   (it is the first line in practice); the latest user record + newest
//!   record timestamp are read from a 256 KiB tail window. Residual: a
//!   matchable user record buried deeper than the tail bound cannot
//!   match — honest degradation (the matching record is the prompt the
//!   pane JUST submitted, which sits at the file's end).
//!
//! Zero cost when idle: scans happen only while at least one armed pane
//! has a due unresolved window, proven by `fs_scan_count`. Callers run
//! `arm()`, `note_submit()`, and `tick()` inside `tokio::task::
//! spawn_blocking` (same discipline as the codex locator).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::opencode_locator::normalize_cwd;
use crate::provider_layout::{AntigravityLayout, ProviderLayout};
use crate::time::parse_timestamp_ms;

/// Submit-anchored evaluation window: a pane's captured submit is
/// evaluated at (or after) `submit_at + WINDOW_MS` — the CLI writes the
/// user record when it processes the prompt, so the window gives it a
/// bounded head start (codex parity: `CODEX_WINDOW_MS`). A window that
/// resolves with zero candidates is re-opened by the next Enter.
pub const ANTIGRAVITY_WINDOW_MS: i64 = 2_000;

/// Bounded submit-text comparison cap (chars, on both the captured line
/// and the record text) — prompts are bounded, never whole-paste dumps.
const MAX_SUBMIT_COMPARE_CHARS: usize = 4096;

/// Bounded head read for the ownership record (bytes).
const MAX_HEAD_BYTES: u64 = 64 * 1024;

/// Bounded tail read for the latest user record + newest record (bytes).
const MAX_TAIL_BYTES: u64 = 256 * 1024;

/// Walk depth for `brain/<conversationId>/.system_generated/logs/` — the
/// layout's own chain is depth 4; 5 tolerates a stray nesting level.
const MAX_WALK_DEPTH: u8 = 5;

/// One resolved pane → conversation match, drained by the ws association
/// sweep (which owns the guard ladder and the adoption/rebind tail).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityLocated {
    pub terminal_id: String,
    pub conversation_id: String,
    pub transcript_path: PathBuf,
}

/// The pane's captured submit (the flushed line at the Enter byte).
#[derive(Debug, Clone, PartialEq, Eq)]
struct CapturedSubmit {
    text: String,
    at_ms: i64,
}

#[derive(Debug, Clone)]
struct Armed {
    cwd_normalized: String,
    /// The latest submit's captured line + the Enter's timestamp. `None`
    /// until the pane's first Enter; replaced by every later Enter.
    submit: Option<CapturedSubmit>,
    /// Whether the CURRENT window has been evaluated. `true` (with
    /// `submit` still set) after a zero/ambiguous/contested resolution —
    /// the next `note_submit` re-opens.
    resolved: bool,
}

#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
}

pub struct AntigravityLocator {
    /// The brain root (`AntigravityLayout::session_root(<home>)`).
    root: PathBuf,
    window_ms: i64,
    inner: Mutex<Inner>,
    fs_scan_count: AtomicU64,
}

/// Normalize a prompt text for comparison: trim + bound.
fn normalize_prompt_text(text: &str) -> String {
    text.trim().chars().take(MAX_SUBMIT_COMPARE_CHARS).collect()
}

impl AntigravityLocator {
    pub fn new(root: PathBuf) -> Self {
        Self::with_config(root, ANTIGRAVITY_WINDOW_MS)
    }

    pub fn with_config(root: PathBuf, window_ms: i64) -> Self {
        Self {
            root,
            window_ms,
            inner: Mutex::new(Inner::default()),
            fs_scan_count: AtomicU64::new(0),
        }
    }

    pub fn armed_count(&self) -> usize {
        self.inner.lock().unwrap().armed.len()
    }

    pub fn fs_scan_count(&self) -> u64 {
        self.fs_scan_count.load(Ordering::SeqCst)
    }

    /// Arm a pane with its cwd (the ws association sweep resolves mode /
    /// managed / running gates against the registry before calling). A
    /// pane STAYS armed across adoption — the SAME rule must keep
    /// evaluating its later submits for the in-CLI switch forms. Idempotent
    /// per terminal; `false` for an empty cwd or an already-armed pane.
    pub fn arm(&self, terminal_id: &str, cwd: &str) -> bool {
        if terminal_id.is_empty() || cwd.trim().is_empty() {
            return false;
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.armed.contains_key(terminal_id) {
            return false;
        }
        inner.armed.insert(
            terminal_id.to_string(),
            Armed {
                cwd_normalized: normalize_cwd(cwd),
                submit: None,
                resolved: false,
            },
        );
        true
    }

    pub fn disarm(&self, terminal_id: &str) {
        self.inner.lock().unwrap().armed.remove(terminal_id);
    }

    /// Record the pane's captured submit line (the association feeds the
    /// hub's flushed line here) and open the evaluation window anchored at
    /// the Enter. REPLACES any in-flight window (see module doc). `false`
    /// for an un-armed pane or an empty (normalized-empty) line — an empty
    /// line can never match a user record's text.
    pub fn note_submit(&self, terminal_id: &str, line_text: &str, at_ms: i64) -> bool {
        let text = normalize_prompt_text(line_text);
        if text.is_empty() {
            return false;
        }
        let mut inner = self.inner.lock().unwrap();
        let Some(armed) = inner.armed.get_mut(terminal_id) else {
            return false;
        };
        armed.submit = Some(CapturedSubmit { text, at_ms });
        armed.resolved = false;
        true
    }

    fn due(&self, armed: &Armed, now_ms: i64) -> bool {
        matches!(&armed.submit, Some(s)
            if !armed.resolved && now_ms >= s.at_ms + self.window_ms)
    }

    /// One evaluation pass over every due armed pane. Candidates are the
    /// transcripts matching the unified content+recency rule (see module
    /// doc). Outcomes: 0 matches → resolve (keep armed, no emission);
    /// 1 match → emit `AntigravityLocated` (the association decides
    /// no-op / first-bind / rebind); >= 2 matches → REFUSE and warn
    /// `antigravity_association_refused {reason:"ambiguous"}`; a
    /// conversation claimed by two panes in the same tick is refused for
    /// BOTH (the codex locator's same-tick cross-claim defense). `tick()`
    /// drains.
    pub fn tick(&self, now_ms: i64) -> Vec<AntigravityLocated> {
        {
            let inner = self.inner.lock().unwrap();
            if !inner.armed.values().any(|a| self.due(a, now_ms)) {
                return Vec::new(); // zero fs cost while no window is due
            }
        }
        let transcripts = self.scan_transcripts();
        let mut inner = self.inner.lock().unwrap();

        // Pass 1: per-pane candidate evaluation.
        let mut claims: Vec<(String, AntigravityLocated)> = Vec::new();
        for (terminal_id, armed) in inner.armed.iter_mut() {
            let Some(submit) = armed.submit.clone() else {
                continue;
            };
            if armed.resolved || now_ms < submit.at_ms + self.window_ms {
                continue;
            }
            armed.resolved = true;
            let mut matches: Vec<AntigravityLocated> = Vec::new();
            for path in &transcripts {
                if !mtime_could_be_recent(path, submit.at_ms) {
                    continue;
                }
                let Some(summary) = probe_transcript(path) else {
                    continue;
                };
                let cwd_in_workspace = summary
                    .workspace_paths
                    .iter()
                    .any(|p| normalize_cwd(p) == armed.cwd_normalized);
                if !cwd_in_workspace {
                    continue;
                }
                if summary.latest_user_text != submit.text {
                    continue;
                }
                // Recency is proven by the MATCHING user record's own
                // timestamp: a transcript whose matching record predates
                // the submit can never match (re-typed old prompts,
                // dead-launch late writes), and a later record of another
                // type (an assistant record still streaming after the
                // submit) never vouches for it. Unprovable timestamps
                // (the matching record's own `at` unparseable) fail
                // toward refusal.
                match summary.latest_user_at {
                    Some(at) if at >= submit.at_ms => {}
                    _ => continue,
                }
                matches.push(AntigravityLocated {
                    terminal_id: terminal_id.clone(),
                    conversation_id: summary.conversation_id,
                    transcript_path: path.clone(),
                });
            }
            match matches.len() {
                0 => {} // keep watching (resolved; the next Enter re-opens)
                1 => claims.push((terminal_id.clone(), matches.remove(0))),
                n => {
                    tracing::warn!(
                        target: "freshell_sessions::antigravity_locator",
                        terminal_id = %terminal_id,
                        candidates = n,
                        event = "antigravity_association_refused",
                        reason = "ambiguous",
                        "antigravity_association_refused: multiple transcripts match the \
                         captured submit; refusing all (never a guess)"
                    );
                }
            }
        }

        // Pass 2: same-tick cross-claim — one conversation claimed by two
        // panes is unattributable even with content matching (identical
        // prompt texts); refuse both, never guess.
        let mut located = Vec::new();
        for (terminal_id, claim) in &claims {
            let contested = claims.iter().any(|(other_tid, other)| {
                other_tid != terminal_id && other.conversation_id == claim.conversation_id
            });
            if contested {
                tracing::warn!(
                    target: "freshell_sessions::antigravity_locator",
                    terminal_id = %terminal_id,
                    conversation_id = %claim.conversation_id,
                    event = "antigravity_association_refused",
                    reason = "contested",
                    "antigravity_association_refused: one conversation claimed by two \
                     panes in one tick; refusing both"
                );
                continue;
            }
            located.push(claim.clone());
        }
        located
    }

    fn scan_transcripts(&self) -> Vec<PathBuf> {
        self.fs_scan_count.fetch_add(1, Ordering::SeqCst);
        fn walk(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
            if depth > MAX_WALK_DEPTH {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                return; // missing/corrupt root tolerated, never a panic
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, depth + 1, out);
                } else if AntigravityLayout.qualifies(&path) {
                    out.push(path);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, 0, &mut out);
        out
    }
}

/// mtime prefilter (never authoritative): a transcript not written since
/// `submit_at - 2 s` cannot carry a record written at/after the submit.
/// An mtime error or a coarse clock falls through to the probe.
fn mtime_could_be_recent(path: &Path, submit_at_ms: i64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return true; // fall through: the probe decides
    };
    let Ok(modified) = meta.modified() else {
        return true;
    };
    let mtime_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    mtime_ms >= submit_at_ms - 2_000
}

/// The facts a candidate transcript must present (all extracted with
/// bounded reads; see module doc).
#[derive(Debug, Clone)]
struct TranscriptSummary {
    /// The FIRST `session_start` record's `conversationId` (the parser's
    /// determinism rule — later ownership records never reassign it).
    conversation_id: String,
    /// That ownership record's `workspacePaths` (verbatim; compared
    /// normalized).
    workspace_paths: Vec<String>,
    /// The LATEST user-authored record's text (normalized+bounded the same
    /// way the captured submit was).
    latest_user_text: String,
    /// That SAME record's own `at` timestamp — recency is proven by the
    /// MATCHING record, never by a later record of another type (a
    /// still-streaming assistant record written after the submit must not
    /// vouch for a user record written before it). `None` when the
    /// matching record's own timestamp is unparseable — fails toward
    /// refusal.
    latest_user_at: Option<i64>,
}

/// Bounded probe of one transcript: the ownership record from the head
/// window, the latest user record's text + its own timestamp from the
/// tail window. `None` = not a candidate this tick (unreadable, no
/// ownership id, or no user record in the tail window) — a transient
/// state the next window re-probes; never a panic on malformed content.
fn probe_transcript(path: &Path) -> Option<TranscriptSummary> {
    use std::io::{Read, Seek, SeekFrom};

    // Ownership record: first complete JSON line with type session_start
    // and a non-empty conversationId (bounded head window).
    let mut file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    {
        let mut limited = (&file).take(MAX_HEAD_BYTES);
        limited.read_to_end(&mut head).ok()?;
    }
    let head_text = String::from_utf8_lossy(&head);
    let mut conversation_id: Option<String> = None;
    let mut workspace_paths: Vec<String> = Vec::new();
    for line in head_text.lines() {
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if obj.get("type").and_then(|v| v.as_str()) != Some("session_start") {
            continue;
        }
        let id = obj
            .get("conversationId")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty());
        if conversation_id.is_none() {
            if let Some(id) = id {
                conversation_id = Some(id.to_string());
                if let Some(paths) = obj.get("workspacePaths").and_then(|v| v.as_array()) {
                    workspace_paths = paths
                        .iter()
                        .filter_map(|p| p.as_str().map(str::to_string))
                        .collect();
                }
                break;
            }
        }
    }
    let conversation_id = conversation_id?;

    // Tail window: latest user record's text + that record's own
    // timestamp. Skip a potentially partial first line when the window
    // starts mid-line.
    let file_len = file.metadata().ok()?.len();
    let tail_start = file_len.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(tail_start)).ok()?;
    let mut tail = Vec::new();
    (&file).take(MAX_TAIL_BYTES).read_to_end(&mut tail).ok()?;
    let tail_text = String::from_utf8_lossy(&tail);
    let mut lines = tail_text.lines().peekable();
    if tail_start > 0 {
        lines.next(); // a fragment, unless the file is smaller than the bound
    }
    let mut latest_user_text: Option<String> = None;
    let mut latest_user_at: Option<i64> = None;
    for line in lines {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // malformed / truncated mid-write tail lands here
        };
        let at = obj
            .get("at")
            .or_else(|| obj.get("startedAt"))
            .and_then(parse_timestamp_ms);
        if obj.get("type").and_then(|v| v.as_str()) == Some("user_message") {
            if let Some(text) = obj.get("text").and_then(serde_json::Value::as_str) {
                // Text and its OWN timestamp move together: recency is
                // proven by the matching record, so the two facts must
                // describe the same record (a later record of another
                // type never vouches for an earlier user record).
                latest_user_text = Some(normalize_prompt_text(text));
                latest_user_at = at;
            }
        }
    }
    let latest_user_text = latest_user_text?;

    Some(TranscriptSummary {
        conversation_id,
        workspace_paths,
        latest_user_text,
        latest_user_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-antigravity-locator-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn locator_for(label: &str) -> (AntigravityLocator, std::path::PathBuf) {
        let home = unique_temp_dir(label);
        let root = home.join("brain");
        std::fs::create_dir_all(&root).unwrap();
        (AntigravityLocator::new(root.clone()), root)
    }

    /// Write a transcript in the fixture format: an ownership record plus
    /// user records (numeric epoch-ms `at` — the shared timestamp
    /// coercion's second accepted form).
    fn write_transcript(
        root: &Path,
        conv: &str,
        cwd: &str,
        records: &[(&str, i64)], // (text, at) user records
    ) -> PathBuf {
        let path = root
            .join(conv)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut body = format!(
            r#"{{"type":"session_start","conversationId":"{conv}","workspacePaths":["{cwd}"],"startedAt":{start}}}"#,
            conv = conv,
            cwd = cwd,
            start = records.first().map(|r| r.1).unwrap_or(0),
        );
        for (text, at) in records {
            body.push_str(&format!(
                "\n{{\"type\":\"user_message\",\"conversationId\":\"{conv}\",\"text\":\"{text}\",\"at\":{at}}}",
            ));
        }
        body.push('\n');
        std::fs::write(&path, body).unwrap();
        path
    }

    const T0: i64 = 1_700_000_000_000;

    #[test]
    fn zero_cost_when_idle_and_zero_turn_never_scans() {
        let (locator, _root) = locator_for("idle");
        assert!(locator.arm("t1", "/tmp"));
        // No submit -> no window -> tick never scans.
        assert!(locator.tick(T0 + 10_000).is_empty());
        assert_eq!(locator.fs_scan_count(), 0, "no window -> zero fs cost");
        // A submit BEFORE the window elapses is not due yet either.
        assert!(locator.note_submit("t1", "hello", T0));
        assert!(locator.tick(T0 + 1_000).is_empty());
        assert_eq!(
            locator.fs_scan_count(),
            0,
            "not-yet-due window -> zero fs cost"
        );
    }

    #[test]
    fn first_submit_matches_the_own_conversation_transcript() {
        let (locator, root) = locator_for("first-bind");
        let cwd = "/tmp/agy-first";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        write_transcript(&root, "conv-own", cwd, &[("hello world", T0)]);
        assert!(locator.note_submit("t1", "hello world", T0));
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].conversation_id, "conv-own");
        assert_eq!(located[0].terminal_id, "t1");
        assert_eq!(
            located[0].transcript_path,
            root.join("conv-own/.system_generated/logs/transcript.jsonl")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_transcript_with_a_different_latest_user_text_never_matches() {
        let (locator, root) = locator_for("wrong-text");
        let cwd = "/tmp/agy-wrong-text";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        write_transcript(
            &root,
            "conv-decoy",
            cwd,
            &[("a completely different prompt", T0)],
        );
        assert!(locator.note_submit("t1", "the real prompt", T0 + 5));
        // The pane's OWN conversation (carrying the right text) must exist
        // too, or the refusal below could pass vacuously.
        write_transcript(&root, "conv-own", cwd, &[("the real prompt", T0 + 10)]);
        let located = locator.tick(T0 + 5 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "only the content-matching transcript binds"
        );
        assert_eq!(located[0].conversation_id, "conv-own");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recency_rejects_transcripts_whose_matching_user_record_predates_the_submit() {
        let (locator, root) = locator_for("recency");
        let cwd = "/tmp/agy-recency";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // An OLD transcript whose latest user record carries exactly the
        // pane's re-typed prompt — that record predates the submit.
        write_transcript(&root, "conv-old", cwd, &[("re-typed old prompt", T0)]);
        assert!(locator.note_submit("t1", "re-typed old prompt", T0 + 60_000));
        // The pane's own fresh conversation (same text, written now).
        write_transcript(
            &root,
            "conv-own",
            cwd,
            &[("re-typed old prompt", T0 + 60_100)],
        );
        let located = locator.tick(T0 + 60_000 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(
            located.len(),
            1,
            "the old transcript is rejected by recency"
        );
        assert_eq!(located[0].conversation_id, "conv-own");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Adversarial recency shape: the transcript's LATEST user record
    /// matches the submit text but was written BEFORE the submit, while a
    /// LATER record of another type (an assistant record still streaming)
    /// was written after it. Recency must be proven by the MATCHING user
    /// record's own timestamp — a newest-record-of-any-type check alone
    /// would let this foreign transcript through as the sole candidate.
    #[test]
    fn recency_requires_the_matching_user_records_own_timestamp_not_a_later_record() {
        let (locator, root) = locator_for("matching-recency");
        let cwd = "/tmp/agy-matching-recency";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        let path = root
            .join("conv-foreign")
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // The foreign transcript: its latest user record (the matching
        // text) was written at T0, and an assistant record written at
        // T0+60_050 keeps the file live AFTER the pane's submit.
        std::fs::write(
            &path,
            format!(
                concat!(
                    r#"{{"type":"session_start","conversationId":"conv-foreign","workspacePaths":["{cwd}"],"startedAt":{t0}}}"#,
                    "\n",
                    r#"{{"type":"user_message","conversationId":"conv-foreign","text":"identical prompt text","at":{t0}}}"#,
                    "\n",
                    r#"{{"type":"assistant_message","conversationId":"conv-foreign","text":"a reply still streaming","at":{after}}}"#,
                    "\n",
                ),
                cwd = cwd,
                t0 = T0,
                after = T0 + 60_050,
            ),
        )
        .unwrap();
        // The pane submits the identical text at T0+60_000: AFTER the
        // matching user record, BEFORE the later assistant record.
        assert!(locator.note_submit("t1", "identical prompt text", T0 + 60_000));
        let located = locator.tick(T0 + 60_000 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "a matching user record written BEFORE the submit is not a candidate, \
             even when a later non-user record postdates the submit: {located:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ambiguous_matches_refuse_all_and_never_guess() {
        let (locator, root) = locator_for("ambiguous");
        let cwd = "/tmp/agy-ambiguous";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "duplicate prompt", T0));
        write_transcript(&root, "conv-a", cwd, &[("duplicate prompt", T0 + 100)]);
        write_transcript(&root, "conv-b", cwd, &[("duplicate prompt", T0 + 100)]);
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "two matching transcripts -> refuse all (never a guess)"
        );
        // The pane STAYS armed: a later solo submit re-opens evaluation.
        assert_eq!(locator.armed_count(), 1);
        assert!(locator.note_submit("t1", "solo follow up", T0 + 10_000));
        write_transcript(
            &root,
            "conv-a",
            cwd,
            &[
                ("duplicate prompt", T0 + 100),
                ("solo follow up", T0 + 10_100),
            ],
        );
        let located = locator.tick(T0 + 10_000 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1, "a later solo window resolves the pane");
        assert_eq!(located[0].conversation_id, "conv-a");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cwd_mismatch_never_matches_even_with_identical_text() {
        let (locator, root) = locator_for("cwd");
        let cwd = "/tmp/agy-cwd";
        let other = "/tmp/agy-cwd-other";
        std::fs::create_dir_all(cwd).unwrap();
        std::fs::create_dir_all(other).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "shared prompt text", T0));
        write_transcript(
            &root,
            "conv-foreign",
            other,
            &[("shared prompt text", T0 + 100)],
        );
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "workspacePaths must CONTAIN the pane cwd"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn multi_workspace_paths_match_on_any_contained_cwd() {
        let (locator, root) = locator_for("multi-cwd");
        let primary = "/tmp/agy-multi-primary";
        let secondary = "/tmp/agy-multi-secondary";
        std::fs::create_dir_all(primary).unwrap();
        std::fs::create_dir_all(secondary).unwrap();
        locator.arm("t1", secondary);
        assert!(locator.note_submit("t1", "secondary prompt", T0));
        let path = root
            .join("conv-multi")
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(
                concat!(
                    r#"{{"type":"session_start","conversationId":"conv-multi","workspacePaths":["{primary}","{secondary}"],"startedAt":{t0}}}"#,
                    "\n",
                    r#"{{"type":"user_message","conversationId":"conv-multi","text":"secondary prompt","at":{t0}}}"#,
                    "\n",
                ),
                primary = primary,
                secondary = secondary,
                t0 = T0,
            ),
        )
        .unwrap();
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1, "any contained workspacePath matches");
        assert_eq!(located[0].conversation_id, "conv-multi");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_later_enter_replaces_the_in_flight_window() {
        let (locator, root) = locator_for("reopen");
        let cwd = "/tmp/agy-reopen";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "first prompt", T0));
        // A second Enter BEFORE the first window resolves: the latest
        // Enter is the live prompt (the transcript's latest user record
        // has moved on) — the captured line is REPLACED, not held.
        assert!(locator.note_submit("t1", "second prompt", T0 + 500));
        write_transcript(
            &root,
            "conv-own",
            cwd,
            &[("first prompt", T0 + 100), ("second prompt", T0 + 600)],
        );
        let located = locator.tick(T0 + 500 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(located[0].conversation_id, "conv-own");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn same_tick_cross_claim_of_one_conversation_is_refused_for_both() {
        let (locator, root) = locator_for("cross-claim");
        let cwd = "/tmp/agy-cross-claim";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        locator.arm("t2", cwd);
        assert!(locator.note_submit("t1", "identical prompt", T0));
        assert!(locator.note_submit("t2", "identical prompt", T0));
        // One transcript with that text — claimed by both panes.
        write_transcript(&root, "conv-one", cwd, &[("identical prompt", T0 + 100)]);
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "one conversation claimed by two panes -> refused for both: {located:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_latest_user_record_wins_over_earlier_ones() {
        let (locator, root) = locator_for("latest-user");
        let cwd = "/tmp/agy-latest-user";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        // The transcript's FIRST user record is an old prompt; the LATEST
        // is the resumed conversation's prompt (the /resume form).
        write_transcript(
            &root,
            "conv-resumed",
            cwd,
            &[("the old prompt", T0), ("the resumed prompt", T0 + 1_000)],
        );
        assert!(locator.note_submit("t1", "the resumed prompt", T0 + 900));
        let located = locator.tick(T0 + 900 + ANTIGRAVITY_WINDOW_MS + 1);
        assert_eq!(located.len(), 1, "the LATEST user record is the evidence");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn note_submit_normalizes_and_bounds_the_captured_line() {
        let (locator, _root) = locator_for("normalize");
        locator.arm("t1", "/tmp");
        assert!(locator.note_submit("t1", "  padded prompt  ", T0));
        assert!(
            !locator.note_submit("t1", "   ", T0),
            "whitespace-only never opens a window"
        );
        assert!(
            !locator.note_submit("t-unknown", "hello", T0),
            "un-armed panes are refused"
        );
        let long = "x".repeat(MAX_SUBMIT_COMPARE_CHARS + 100);
        assert!(locator.note_submit("t1", &long, T0));
        {
            // Scope the guard: note_submit re-locks the same (non-reentrant)
            // mutex below.
            let inner = locator.inner.lock().unwrap();
            let captured = inner
                .armed
                .get("t1")
                .and_then(|a| a.submit.as_ref())
                .expect("captured submit");
            assert_eq!(captured.text.chars().count(), MAX_SUBMIT_COMPARE_CHARS);
            assert_eq!(captured.text, "x".repeat(MAX_SUBMIT_COMPARE_CHARS));
        }
        assert!(
            locator.note_submit("t1", "padded prompt", T0 + 1),
            "a fresh submit replaces the bounded window"
        );
    }

    #[test]
    fn arm_is_idempotent_and_requires_a_cwd() {
        let (locator, _root) = locator_for("arm");
        assert!(locator.arm("t1", "/tmp"));
        assert!(
            !locator.arm("t1", "/tmp"),
            "already armed -> idempotent false"
        );
        assert!(!locator.arm("t2", ""), "empty cwd -> refused");
        assert!(!locator.arm("", "/tmp"), "empty terminal id -> refused");
        locator.disarm("t1");
        assert_eq!(locator.armed_count(), 0);
    }

    #[test]
    fn non_transcript_files_in_the_root_are_never_candidates() {
        let (locator, root) = locator_for("layout");
        let cwd = "/tmp/agy-layout";
        std::fs::create_dir_all(cwd).unwrap();
        locator.arm("t1", cwd);
        assert!(locator.note_submit("t1", "layout prompt", T0));
        // A cache file the layout explicitly excludes, plus a misplaced
        // transcript (wrong ancestor chain) — neither may ever bind.
        std::fs::create_dir_all(root.parent().unwrap().join("cache")).unwrap();
        std::fs::write(
            root.parent().unwrap().join("cache/last_conversations.json"),
            r#"{"type":"session_start","conversationId":"conv-cache","workspacePaths":["/tmp/agy-layout"],"startedAt":1}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("conv-misplaced/logs")).unwrap();
        std::fs::write(
            root.join("conv-misplaced/logs/transcript.jsonl"),
            format!(
                r#"{{"type":"session_start","conversationId":"conv-misplaced","workspacePaths":["{cwd}"],"startedAt":{T0}}}"#,
            ),
        )
        .unwrap();
        let located = locator.tick(T0 + ANTIGRAVITY_WINDOW_MS + 1);
        assert!(
            located.is_empty(),
            "only the layout's transcript chain qualifies"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
