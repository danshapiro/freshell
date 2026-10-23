//! Claude fresh-agent snapshot adapter (restart-resilience plan §2.8 item 4).
//!
//! Reads the Claude CLI's own transcript store (`<store-root>/projects/<cwd-slug>/
//! <uuid>.jsonl`) directly -- the first file-reading snapshot source in the Rust port.
//! Design choice over codex's resume-and-ask: the sidecar protocol has no history op,
//! the SDK's own `getSessionMessages` is itself just a local JSONL read with the same
//! root resolution (ledger A16), a sidecar resume burns a real SDK process per
//! snapshot GET, and the legacy Node server already proved direct-read viable
//! (`server/session-history-loader.ts` -- with real-store parsing fixes, ledger A5).
//! Store-root resolution is ORDERED CANDIDATES (`CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` >
//! platform home `.claude`, the platform home being `std::env::home_dir()` exactly
//! like the CLI's `os.homedir()`) because the real CLI honors CLAUDE_CONFIG_DIR and
//! IGNORES CLAUDE_HOME (ledger A3) -- reading a single root risks false positive
//! denial. The transcript store is also the AUTHORITY for lost-vs-alive on attach
//! ([`crate::FreshClaudeState::handle_attach`]): file present => resumable, a CLEAN
//! miss in EVERY candidate root => positively gone (mirrors opencode's 404 rule;
//! honest even under claude's 30-day `cleanupPeriodDays` GC -- an expired transcript
//! is unresumable by the CLI too, ledger A4), and a store that cannot be read is
//! "cannot check", never gone ([`TranscriptLocation`], G28).

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::summary::{truncate_summary, SUMMARY_KIND_ECHO, TOOL_ERROR_LABEL, TOOL_RESULT_LABEL};

/// Ordered candidate store roots -- the ONE store-root rule every claude
/// transcript caller shares (snapshot, resume-on-attach, rollback, naming,
/// reconcile existence). The real CLI resolves its store as
/// `CLAUDE_CONFIG_DIR ?? os.homedir()/.claude` and IGNORES `CLAUDE_HOME`
/// (verified against cli.js 2.1.220 -- ledger A3); `CLAUDE_HOME` is freshell's
/// legacy knob (`server/claude-home.ts`, `session_directory.rs`). The platform
/// home is [`std::env::home_dir`] -- USERPROFILE on Windows (HOME is never read
/// there), HOME-else-passwd-entry on POSIX -- exactly Node's `os.homedir()`, so
/// the Windows desktop app (no HOME) and a POSIX service with HOME unset still
/// find the store the CLI writes. We read ALL candidates so a reader/writer
/// root mismatch can never turn a live session into a false positive denial.
pub fn claude_home_candidates() -> Vec<PathBuf> {
    claude_home_candidates_from(|key| std::env::var(key).ok(), std::env::home_dir())
}

/// Pure form of [`claude_home_candidates`]: `var` is the environment lookup and
/// `home` the platform home, both injected so the rule is testable without
/// mutating process-global env. Empty values never produce a (bogus,
/// cwd-relative) root; duplicates are scanned once, first position wins.
pub(crate) fn claude_home_candidates_from(
    var: impl Fn(&str) -> Option<String>,
    home: Option<PathBuf>,
) -> Vec<PathBuf> {
    let explicit = ["CLAUDE_CONFIG_DIR", "CLAUDE_HOME"]
        .into_iter()
        .filter_map(|key| var(key).filter(|v| !v.is_empty()).map(PathBuf::from));
    let platform_default = home
        .filter(|h| !h.as_os_str().is_empty())
        .map(|h| h.join(".claude"));
    let mut out: Vec<PathBuf> = Vec::new();
    for root in explicit.chain(platform_default) {
        if !out.iter().any(|seen| same_store_root(seen, &root)) {
            out.push(root);
        }
    }
    out
}

/// Two spellings of the same store root are scanned once. Path equality
/// compares components (separators and a trailing slash never matter); on
/// Windows each component also compares case-insensitively, the filesystem's
/// own rule, so `C:/USERS/u/.claude/` and `C:\Users\u\.claude` are one root.
#[cfg(not(windows))]
fn same_store_root(left: &Path, right: &Path) -> bool {
    left == right
}

#[cfg(windows)]
fn same_store_root(left: &Path, right: &Path) -> bool {
    same_windows_path(left, right)
}

#[cfg(windows)]
fn same_windows_path(left: &Path, right: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Component;

    const CSTR_EQUAL: i32 = 2;
    const TRUE: i32 = 1;

    let components_match = |left: Component<'_>, right: Component<'_>| {
        let left = left.as_os_str().encode_wide().collect::<Vec<_>>();
        let right = right.as_os_str().encode_wide().collect::<Vec<_>>();
        let (Ok(left_len), Ok(right_len)) = (i32::try_from(left.len()), i32::try_from(right.len()))
        else {
            return false;
        };
        if left_len == 0 || right_len == 0 {
            return false;
        }

        // SAFETY: both buffers remain alive for the call, and each explicit
        // length is the number of valid UTF-16 code units in that buffer.
        unsafe {
            compare_string_ordinal(left.as_ptr(), left_len, right.as_ptr(), right_len, TRUE)
                == CSTR_EQUAL
        }
    };

    let mut left = left.components();
    let mut right = right.components();
    loop {
        match (left.next(), right.next()) {
            (Some(left), Some(right)) if components_match(left, right) => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "CompareStringOrdinal"]
    fn compare_string_ordinal(
        string1: *const u16,
        count1: i32,
        string2: *const u16,
        count2: i32,
        ignore_case: i32,
    ) -> i32;
}

/// Where a claude transcript stands across the store roots (G28). Only a CLEAN
/// miss in EVERY candidate root is [`TranscriptLocation::Absent`] -- the positive
/// "session gone" evidence attach, snapshot and rollback act on. Any IO failure
/// that could be hiding the file is [`TranscriptLocation::Unreadable`]: the
/// caller must treat it as "cannot check" (transient / 500 / retryable), never
/// as lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptLocation {
    /// The transcript file, found under one of the roots (a hit wins even when
    /// another root or project dir failed to read).
    Found(PathBuf),
    /// Every root was fully readable and none holds the transcript.
    Absent,
    /// No hit, and at least one root could not be fully checked (or there is
    /// no root at all).
    Unreadable(LocateError),
}

/// Why the store could not be checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocateError {
    /// No store root resolves at all (no CLAUDE_CONFIG_DIR / CLAUDE_HOME and
    /// no platform home).
    NoStoreRoot,
    /// The first IO error met while scanning `root` (expected absence --
    /// `NotFound` / `NotADirectory` -- is a clean miss, never an error).
    Io {
        root: PathBuf,
        kind: std::io::ErrorKind,
        message: String,
    },
}

impl TranscriptLocation {
    /// The located path, if found. Callers that only DISPLAY (redo
    /// availability, naming evidence) may collapse Absent and Unreadable;
    /// callers that DECIDE "lost" must match all three states instead.
    pub fn found(self) -> Option<PathBuf> {
        match self {
            Self::Found(path) => Some(path),
            Self::Absent | Self::Unreadable(_) => None,
        }
    }
}

impl LocateError {
    fn io(root: &Path, error: &std::io::Error) -> Self {
        Self::Io {
            root: root.to_path_buf(),
            kind: error.kind(),
            message: error.to_string(),
        }
    }

    /// Stable short label (`PermissionDenied`, `no_store_root`) for structured
    /// logs and user-facing refusals.
    pub fn kind_label(&self) -> String {
        match self {
            Self::NoStoreRoot => "no_store_root".to_string(),
            Self::Io { kind, .. } => format!("{kind:?}"),
        }
    }
}

impl std::fmt::Display for LocateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoStoreRoot => f.write_str(
                "no claude store root resolvable (CLAUDE_CONFIG_DIR/CLAUDE_HOME/platform home all unset)",
            ),
            Self::Io { root, message, .. } => write!(
                f,
                "claude transcript store {} unreadable: {message}",
                root.display()
            ),
        }
    }
}

/// [`TranscriptLocation`] for `session_id` across [`claude_home_candidates`],
/// in resolution order. Positive denial (attach), the snapshot 404 and the
/// rollback "nothing there" answers all require a CLEAN miss EVERYWHERE.
/// `pub` + re-exported at the crate root (kata 09v1): `freshell-server`'s
/// `IndexExistenceProbe` consults this SAME check before finalizing a
/// warm-index `Absent` for claude — an on-disk transcript can be cwd-less
/// (fixture's create-time 0-byte file; crash-window partial writes) and so
/// fail the index's R10b cwd gate while the attach arm would still attempt
/// resume on it; the reconcile arm and the attach arm must share one
/// definition of "the transcript exists".
pub fn locate_transcript_state(session_id: &str) -> TranscriptLocation {
    locate_transcript_state_in(&claude_home_candidates(), session_id)
}

/// [`locate_transcript_state`] over explicit roots: the first hit wins;
/// otherwise the first root error makes the answer Unreadable; only an
/// all-clean miss is Absent; no roots at all is `Unreadable(NoStoreRoot)`.
pub(crate) fn locate_transcript_state_in(
    roots: &[PathBuf],
    session_id: &str,
) -> TranscriptLocation {
    if roots.is_empty() {
        return TranscriptLocation::Unreadable(LocateError::NoStoreRoot);
    }
    let mut first_error: Option<LocateError> = None;
    for root in roots {
        match find_transcript_state(root, session_id) {
            TranscriptLocation::Found(path) => return TranscriptLocation::Found(path),
            TranscriptLocation::Absent => {}
            TranscriptLocation::Unreadable(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    first_error.map_or(TranscriptLocation::Absent, TranscriptLocation::Unreadable)
}

/// Found-only view of [`locate_transcript_state`] for DISPLAY callers
/// (`claude_can_redo_now`: an unreadable original reads as "no redo now").
/// Anything that decides "this session is gone" must match the three-state
/// [`locate_transcript_state`] instead.
pub fn locate_transcript(session_id: &str) -> Option<PathBuf> {
    locate_transcript_state(session_id).found()
}

/// One structured warn per "cannot check" decision (G28): which caller, the
/// session, the failing store root and the io error kind -- never transcript
/// contents. Callers then answer transiently instead of "lost".
pub(crate) fn log_transcript_unreadable(
    context: &'static str,
    session_id: &str,
    error: &LocateError,
) {
    let root = match error {
        LocateError::NoStoreRoot => None,
        LocateError::Io { root, .. } => Some(root.display().to_string()),
    };
    tracing::warn!(
        component = "freshagent.claude",
        event = "freshagent.claude.transcript_unreadable",
        context,
        session_id = %session_id,
        root = ?root,
        kind = %error.kind_label(),
        error = %error,
        "claude transcript store unreadable; answering transiently, never as a lost session"
    );
}

/// The rollback refusal for a transcript store that cannot be read (G28): the
/// retryable `INTERNAL_ERROR` the rollback read-error legs already answer --
/// never `NOTHING_TO_UNDO` / `REDO_UNAVAILABLE`, which tell the user the
/// history is gone. Logs the structured unreadable warning.
pub(crate) fn unreadable_rollback_refusal(
    op: &crate::rollback_record::RollbackRequest,
    session_id: &str,
    error: &LocateError,
) -> freshell_protocol::ServerMessage {
    log_transcript_unreadable("rollback", session_id, error);
    crate::rollback_record::rollback_error_frame(
        op,
        "INTERNAL_ERROR",
        &format!("claude transcript store unreadable: {}", error.kind_label()),
    )
}

/// Unified agent names (Task 2): a located transcript PLUS the routing
/// evidence the naming store retains with the record — the SELECTED root
/// the transcript was found under (never an ambient default) and the
/// transcript's original cwd.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectedTranscript {
    /// The config root the transcript was located under (the store-root
    /// candidate that matched — `CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` >
    /// platform home `.claude`).
    pub config_root: PathBuf,
    /// The transcript file's absolute path.
    pub transcript_path: PathBuf,
    /// The session's ORIGINAL cwd (first non-empty `cwd` in the transcript,
    /// bounded read) — the native location's routing input.
    pub transcript_cwd: Option<String>,
}

/// Unified agent names (Task 2): locate a transcript and answer its
/// SELECTED root + original cwd — the exact evidence a verified claude
/// naming acquisition carries. Uses the same ordered candidates and
/// traversal as [`locate_transcript`] (one definition of "the transcript
/// exists"); the shared candidates already resolve the platform home the
/// real CLI uses (`%USERPROFILE%\.claude` on native Windows), so a session
/// created by the Windows CLI is verifiable from the service host. `None`
/// when the transcript cannot be located anywhere.
pub fn locate_transcript_selected(session_id: &str) -> Option<SelectedTranscript> {
    for root in claude_home_candidates() {
        if let Some(path) = find_transcript(&root, session_id) {
            let transcript_cwd = transcript_cwd_bounded(&path);
            return Some(SelectedTranscript {
                config_root: root,
                transcript_path: path,
                transcript_cwd,
            });
        }
    }
    None
}

/// The session's ORIGINAL cwd: first non-empty `cwd` field among the transcript's
/// lines (100% of real user/assistant lines carry it -- ledger A5 census). Needed
/// because the CLI's resume lookup is scoped to the original cwd's project slug
/// (ledger A15). Reads lazily, stops at the first hit; malformed lines skipped.
pub fn transcript_cwd(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(serde_json::Value::as_str) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Node's `CWD_SCAN_BYTES` (`claude-transcript-locator.ts:31`): the resolve
/// endpoint's cwd read never scans past the first 64 KiB of a transcript.
const CWD_SCAN_BYTES: u64 = 64 * 1024;

/// Bounded variant of [`transcript_cwd`] for the resume-resolve claude
/// exact-id fallback (`crates/freshell-server/src/main.rs`). Node parity
/// (`claude-transcript-locator.ts:121-152` `readCwdFromTranscript`): read AT
/// MOST the first [`CWD_SCAN_BYTES`] of the file, split that prefix on
/// `\n`, and attempt to parse EVERY segment INCLUDING the final one —
/// Node's `head.split('\n')` loop has no discard-the-truncated-tail rule (a
/// fragment cut at the 64 KiB boundary simply fails `JSON.parse` and is
/// skipped, while a COMPLETE final line with no trailing newline still
/// parses). First non-empty string `cwd` wins. One resolve request against
/// a multi-GB transcript (or a single enormous line) must not allocate or
/// scan past the 64 KiB prefix — do NOT swap this for [`transcript_cwd`]'s
/// unbounded `BufRead::lines()` loop.
///
/// Errors are swallowed to `None` like [`transcript_cwd`]; the
/// error-PROPAGATING variant for the provider-error channel is
/// [`transcript_cwd_checked`].
pub fn transcript_cwd_bounded(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    file.take(CWD_SCAN_BYTES).read_to_end(&mut head).ok()?;
    // Node's Buffer.toString('utf8') is lossy at the truncation boundary;
    // from_utf8_lossy matches (replacement chars only ever land in the
    // final fragment, which then fails to parse — same as Node).
    let head = String::from_utf8_lossy(&head);
    for segment in head.split('\n') {
        let trimmed = segment.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Locate `<claude_home>/projects/*/<session_id>.jsonl` (or one subdir deeper, e.g.
/// `<project>/<session-id-dir>/...` layouts). Filename scan, NEVER slug re-derivation:
/// the cwd->slug encoding is lossy (`docs/port-plan.md:45`). Sorted dirs for
/// determinism (mirrors `directory_index.rs::discover_claude_home`). Found-only
/// projection of [`find_transcript_state`] (one traversal).
pub(crate) fn find_transcript(claude_home: &Path, session_id: &str) -> Option<PathBuf> {
    find_transcript_state(claude_home, session_id).found()
}

/// The three-state traversal of ONE store root, same layout as
/// [`find_transcript`] (direct, plus one nested level; only real directories
/// are descended). Expected absence (`NotFound` / `NotADirectory`) is a clean
/// miss, and so is an id the OS refuses as a file name (no such transcript can
/// exist). Any other error is REMEMBERED and the scan keeps going -- a later hit
/// still wins -- so the root answers Unreadable only when nothing was found
/// and something could not be checked.
pub(crate) fn find_transcript_state(claude_home: &Path, session_id: &str) -> TranscriptLocation {
    if !is_safe_session_id(session_id) {
        return TranscriptLocation::Absent;
    }
    let filename = format!("{session_id}.jsonl");
    let mut errors = ScanErrors::default();
    for dir in subdirs_sorted(&claude_home.join("projects"), &mut errors) {
        let direct = dir.join(&filename);
        if is_file_or_remember(&direct, &mut errors) {
            return TranscriptLocation::Found(direct);
        }
        for sub in subdirs_sorted(&dir, &mut errors) {
            let nested = sub.join(&filename);
            if is_file_or_remember(&nested, &mut errors) {
                return TranscriptLocation::Found(nested);
            }
        }
    }
    match errors.first() {
        Some(e) => TranscriptLocation::Unreadable(LocateError::io(claude_home, e)),
        None => TranscriptLocation::Absent,
    }
}

/// The one error sink of a [`find_transcript_state`] scan: every branch
/// (opening a dir, reading one listed entry, probing a candidate) reports
/// here, so the expected-absence rule lives in exactly one place. Expected
/// absence (`NotFound` / `NotADirectory` -- e.g. an entry deleted between
/// the listing and its type check) is never remembered; the FIRST real
/// error is kept for the Unreadable answer.
#[derive(Default)]
struct ScanErrors(Option<std::io::Error>);

impl ScanErrors {
    fn remember(&mut self, e: std::io::Error) {
        if !is_expected_absence(&e) {
            self.0.get_or_insert(e);
        }
    }

    fn first(&self) -> Option<&std::io::Error> {
        self.0.as_ref()
    }
}

/// Sorted child DIRECTORIES of `dir` -- the historic [`find_transcript`]
/// filter (`DirEntry::file_type`, which does not follow symlinks). Any error
/// -- opening `dir` or reading one entry -- goes to `errors` (which drops
/// expected absence) and the readable entries are still returned.
fn subdirs_sorted(dir: &Path, errors: &mut ScanErrors) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            errors.remember(e);
            return Vec::new();
        }
    };
    collect_subdirs(
        entries
            .map(|entry| entry.and_then(|entry| Ok((entry.file_type()?.is_dir(), entry.path())))),
        errors,
    )
}

/// The per-entry half of [`subdirs_sorted`]: each listed entry is
/// `(is_dir, path)` or the error reading it. Directories are kept, sorted;
/// an entry's error goes to `errors` and the fold keeps going, so one bad
/// entry never hides the readable ones. Split out because the test
/// filesystems (ext4/tmpfs report `d_type`) cannot make one entry fail.
fn collect_subdirs(
    entries: impl IntoIterator<Item = std::io::Result<(bool, PathBuf)>>,
    errors: &mut ScanErrors,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in entries {
        match entry {
            Ok((true, path)) => out.push(path),
            Ok((false, _)) => {}
            Err(e) => errors.remember(e),
        }
    }
    out.sort();
    out
}

/// [`candidate_is_file`] with its error handed to `errors` (a miss for this
/// candidate; the scan goes on). An error that says the candidate's NAME is
/// invalid is a plain miss instead: every other component of the path came
/// from a successful listing, so the rejected name is the id-derived
/// `<id>.jsonl`, and no transcript can exist under a name the OS refuses --
/// that is the id's fault, not the store's.
fn is_file_or_remember(path: &Path, errors: &mut ScanErrors) -> bool {
    match candidate_is_file(path) {
        Ok(is_file) => is_file,
        Err(e) if is_impossible_file_name(&e) => false,
        Err(e) => {
            errors.remember(e);
            false
        }
    }
}

/// The OS refused the path as a name, not as an unreadable place: too long
/// for one path component (`ENAMETOOLONG`), a reserved character on Windows
/// (`ERROR_INVALID_NAME`) -- both `InvalidFilename` -- or a NUL byte, which
/// std rejects as `InvalidInput` before any syscall.
fn is_impossible_file_name(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::InvalidFilename | std::io::ErrorKind::InvalidInput
    )
}

/// Error-AWARE variant of [`locate_transcript`] for the resolve endpoint's
/// provider-health channel (#586 parity): an unreadable claude store must
/// surface as a provider error, never a silent miss. A missing projects dir
/// (`NotFound`) is a genuine miss for that root; any OTHER io error
/// propagates.
///
/// The projects roots are a PARAMETER, exactly like Node's locator takes
/// `projectsDir` (`claude-transcript-locator.ts:65-67`) — the CALLER resolves
/// the environment. Do NOT resolve roots via `claude_home_candidates()`
/// here: that helper adds `CLAUDE_CONFIG_DIR` and bare-`CLAUDE_HOME` roots
/// that Node's resolver (`getSessionRoots()` = `getClaudeHome()/projects`,
/// `providers/claude.ts:524-535`, `server/claude-home.ts:4-7`) and the Rust
/// session index intentionally exclude — with an explicit `CLAUDE_HOME`
/// override it would expose transcripts from a root Node never searches.
/// Parameterizing the roots also keeps the unit tests hermetic: they pass
/// temp dirs and never mutate process-global env.
///
/// Traversal order is Node's GLOBAL two-pass order
/// (`claude-transcript-locator.ts:69-88`): PASS 1 probes the DIRECT layout
/// across ALL roots, then PASS 2 probes the subagent layout across all roots
/// — NOT per-root direct+subagent. (With roots `[A, B]`: A direct, B direct,
/// A subagent, B subagent.)
pub fn locate_transcript_checked(
    projects_roots: &[PathBuf],
    session_id: &str,
) -> Result<Option<PathBuf>, std::io::Error> {
    // PASS 1 — direct layout across all roots.
    for projects in projects_roots {
        if let Some(path) = find_transcript_checked_direct(projects, session_id)? {
            return Ok(Some(path));
        }
    }
    // PASS 2 — subagent layout, only when the direct layout missed everywhere.
    for projects in projects_roots {
        if let Some(path) = find_transcript_checked_subagent(projects, session_id)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Node parity (`claude-transcript-locator.ts:33-37`): expected absence is
/// `ENOENT || ENOTDIR` — a missing dir OR a non-directory path component is
/// a genuine miss; everything else is a provider failure.
fn is_expected_absence(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// The traversal guard [`find_transcript`] applies, shared by the checked
/// helpers: reject ids that could escape the store root.
fn is_safe_session_id(session_id: &str) -> bool {
    !(session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains(".."))
}

/// Sorted entry paths of `dir` — Node's `readdirOrEmpty`
/// (`claude-transcript-locator.ts:95-102`): expected absence reads as an
/// EMPTY listing; any other error PROPAGATES. No file-type filtering: Node
/// probes every entry and lets a non-directory read as an ENOTDIR miss at
/// the candidate probe. Sorted for determinism (the unchecked
/// `find_transcript` convention).
fn read_dir_sorted_or_empty(dir: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if is_expected_absence(&e) => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in entries {
        out.push(entry?.path());
    }
    out.sort();
    Ok(out)
}

/// One candidate probe (Node's `probeTranscript` stat,
/// `claude-transcript-locator.ts:105-113`): `Ok(true)` iff a regular file
/// exists at `path`; expected absence (incl. ENOTDIR from a file path
/// component) is a miss; any OTHER error propagates. `std::fs::metadata`,
/// never the error-swallowing `Path::is_file()`.
fn candidate_is_file(path: &Path) -> Result<bool, std::io::Error> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(meta.is_file()),
        Err(e) if is_expected_absence(&e) => Ok(false),
        Err(e) => Err(e),
    }
}

/// PASS-1 helper: Node's DIRECT layout `<projects>/<project-dir>/<id>.jsonl`
/// (`claude-transcript-locator.ts:39-44,71-76`), with error propagation.
/// CAUTION: intentionally NOT the unchecked [`find_transcript`] layout — that
/// one probes `<project-dir>/<subdir>/<id>.jsonl` without the `subagents`
/// segment, which diverges from Node and misses child sessions.
fn find_transcript_checked_direct(
    projects: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, std::io::Error> {
    if !is_safe_session_id(session_id) {
        return Ok(None);
    }
    let filename = format!("{session_id}.jsonl");
    for dir in read_dir_sorted_or_empty(projects)? {
        let candidate = dir.join(&filename);
        if candidate_is_file(&candidate)? {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// PASS-2 helper: Node's SUBAGENT layout
/// `<projects>/<project-dir>/<parent-session>/subagents/<id>.jsonl`
/// (`claude-transcript-locator.ts:45-48,78-88`), with error propagation.
fn find_transcript_checked_subagent(
    projects: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, std::io::Error> {
    if !is_safe_session_id(session_id) {
        return Ok(None);
    }
    let filename = format!("{session_id}.jsonl");
    for dir in read_dir_sorted_or_empty(projects)? {
        for parent in read_dir_sorted_or_empty(&dir)? {
            let candidate = parent.join("subagents").join(&filename);
            if candidate_is_file(&candidate)? {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}

/// Error-AWARE variant of [`transcript_cwd_bounded`] for the resolve
/// endpoint's provider-health channel. An open error of expected-absence
/// kind is `Ok(None)` — the file existed a moment ago (the locate probe
/// succeeded), so absence = raced deletion and the hit survives, cwd-less
/// (Node behaves the same, `claude-transcript-locator.ts:121-129`); any
/// OTHER open/read error PROPAGATES (Node wraps these in
/// `ClaudeTranscriptLocatorError`). Same 64 KiB bounded read + tolerant
/// per-segment parse as [`transcript_cwd_bounded`] — malformed lines are
/// skipped, the final unterminated segment is still attempted.
pub fn transcript_cwd_checked(path: &Path) -> Result<Option<String>, std::io::Error> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if is_expected_absence(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut head = Vec::new();
    file.take(CWD_SCAN_BYTES).read_to_end(&mut head)?;
    let head = String::from_utf8_lossy(&head);
    for segment in head.split('\n') {
        let trimmed = segment.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                return Ok(Some(cwd.to_string()));
            }
        }
    }
    Ok(None)
}

/// Why a claude snapshot could not be served.
#[derive(Debug)]
pub(crate) enum ClaudeSnapshotError {
    /// No transcript file for this id -- the store positively does not know it
    /// (maps to 404 FRESH_AGENT_LOST_SESSION, the codex/opencode convention).
    NotFound,
    /// The file exists but could not be read; the message becomes the 500 error body.
    Io(String),
}

/// The display turns of a whole transcript: the per-line projection below
/// ([`parse_transcript_turn_indexed`]) folded by the stateful
/// [`crate::claude_projection::ClaudeTranscriptProjector`] (delegations absorb
/// their results and task notifications; re-appended lines project once).
fn parse_transcript_turns(thread_id: &str, transcript: &str) -> Vec<Value> {
    crate::claude_projection::ClaudeTranscriptProjector::project(thread_id, transcript).turns
}

/// One transcript JSONL line -> zero-or-one snapshot turn. Parsing rules are the
/// legacy `extractChatMessagesFromJsonl` contract (`server/session-history-loader.ts:36-131`)
/// PLUS the real-store fixes from the ledger A5 census (23,615 real lines): keep only
/// type user|assistant (and the visible system lines: compaction markers and local
/// command output); message may be a plain string, `{content: [...]}`, or
/// `{content: "<string>"}` (the DOMINANT real prompt shape, which legacy-as-coded
/// drops); lines flagged isMeta/isSidechain/isCompactSummary/isVisibleInTranscriptOnly
/// are synthetic/subagent noise and are SKIPPED; malformed lines and unknown block
/// kinds are skipped, never fatal.
pub(crate) fn parse_transcript_turn(obj: &Value, thread_id: &str, ordinal: usize) -> Option<Value> {
    parse_transcript_turn_indexed(obj, thread_id, ordinal, None)
}

pub(crate) fn parse_transcript_turn_indexed(
    obj: &Value,
    thread_id: &str,
    ordinal: usize,
    index_key: Option<&str>,
) -> Option<Value> {
    let line_type = obj.get("type").and_then(Value::as_str)?;
    if !matches!(line_type, "user" | "assistant" | "system") {
        return None;
    }
    // Real transcripts flag synthetic/subagent lines (ledger A5): skip them.
    // The compact summary (`isCompactSummary`) is the model-facing recap of the
    // compacted history; the visible marker comes from `system/compact_boundary`.
    if is_synthetic_line(obj) {
        return None;
    }
    let line_uuid = obj
        .get("uuid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    // kata 1wxv: real message uuids are the rollback-addressable turn identity;
    // the synthetic {thread}:{ordinal} stays as the fallback for uuid-less lines.
    let turn_id = line_uuid
        .map(str::to_string)
        .unwrap_or_else(|| format!("{thread_id}:{ordinal}"));
    if line_type == "system" {
        return system_line_turn(obj, &turn_id, ordinal);
    }
    // A background agent's completion arrives as an unsolicited USER line
    // carrying `<task-notification>` XML (CLI 2.1.237, F6). It is provider
    // bookkeeping, not something the user typed: the transcript projector folds
    // it into the owning delegation instead.
    if is_task_notification_line(obj) {
        return None;
    }
    let msg = obj.get("message");
    let blocks: Vec<Value> = match msg {
        Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
        Some(Value::Object(m)) => match m.get("content") {
            Some(Value::Array(arr)) => arr.clone(),
            Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
            _ => return None,
        },
        _ => return None,
    };
    if line_type == "user" {
        if let Some(turn) = local_command_user_turn(&blocks, &turn_id, ordinal, obj) {
            return turn;
        }
    }
    let role = if line_type == "user" {
        "user"
    } else {
        "assistant"
    };
    // An API failure is persisted as a synthetic assistant line whose text is
    // the error (`isApiErrorMessage`, F14): the durable error module renders it.
    if role == "assistant" && obj.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
        let message = blocks_text(&blocks);
        let message = if message.trim().is_empty() {
            "API error".to_string()
        } else {
            message
        };
        let error = json!({ "name": "ApiError", "message": message });
        return Some(turn_json(
            &turn_id,
            ordinal,
            role,
            Vec::new(),
            Some(error),
            obj,
        ));
    }
    let mut items: Vec<Value> = Vec::new();
    for (j, block) in blocks.iter().enumerate() {
        let j = index_key
            .and_then(|key| block.get(key))
            .and_then(Value::as_u64)
            .map(|index| index as usize)
            .unwrap_or(j);
        let item_id = format!("{turn_id}-i{j}");
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    // A slash command the user ran is persisted as
                    // `<command-name>/x</command-name>…<command-args>…` (F8/F10):
                    // show what the user typed.
                    let text = match role {
                        "user" => slash_command_text(text).unwrap_or_else(|| text.to_string()),
                        _ => text.to_string(),
                    };
                    items.push(json!({ "id": item_id, "kind": "text", "text": text }));
                }
            }
            // Attachments are placeholders only (codex parity, `codex.rs`
            // userMessage parts): base64 payloads never reach the snapshot.
            Some("image") => {
                items.push(json!({ "id": item_id, "kind": "text", "text": IMAGE_PLACEHOLDER }));
            }
            Some("thinking") => {
                let text = block
                    .get("thinking")
                    .or_else(|| block.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                items.push(json!({ "id": item_id, "kind": "thinking", "text": text }));
            }
            Some("tool_use") => {
                let tool_use_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(item_id.as_str())
                    .to_string();
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                let mut item = Map::new();
                item.insert("id".into(), json!(item_id));
                item.insert("kind".into(), json!("tool_use"));
                item.insert("toolUseId".into(), json!(tool_use_id));
                item.insert("name".into(), json!(name));
                if let Some(input) = block.get("input") {
                    item.insert("input".into(), input.clone());
                }
                items.push(Value::Object(item));
            }
            Some("tool_result") => {
                let tool_use_id = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or(item_id.as_str())
                    .to_string();
                let is_error = block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                items.push(json!({
                    "id": item_id,
                    "kind": "tool_result",
                    "toolUseId": tool_use_id,
                    "content": tool_result_text(block),
                    "isError": is_error,
                }));
            }
            _ => {}
        }
    }
    if items.is_empty() {
        return None;
    }
    Some(turn_json(&turn_id, ordinal, role, items, None, obj))
}

/// A line the CLI writes for itself or for a subagent, never shown as a turn
/// and never a rollback step: meta lines (the local-command caveat), sidechain
/// lines, the compaction summary, transcript-only lines.
fn is_synthetic_line(obj: &Value) -> bool {
    [
        "isMeta",
        "isSidechain",
        "isCompactSummary",
        "isVisibleInTranscriptOnly",
    ]
    .iter()
    .any(|k| obj.get(*k).and_then(Value::as_bool) == Some(true))
}

/// Display text for an image attachment or an image tool result.
const IMAGE_PLACEHOLDER: &str = "[image]";

/// Summary of a compaction-marker turn (the session-host text capture falls
/// back to the summary for item kinds without text).
const CONTEXT_COMPACTED_LABEL: &str = "Context compacted";

/// The one turn-JSON builder every projection arm shares. `error` is the
/// durable error module's `{name, message}`; an error-only turn (no items)
/// keeps a BLANK summary (LB-4: the client renders a zero-item turn's summary
/// as its body, which would duplicate the error module). This departs from
/// transcript-live plan §4.3, which put the error message in the summary for
/// the session-host text capture; that capture (`render_snapshot_text` in
/// freshell-session-host) reads an error-only turn's `error.message` instead.
fn turn_json(
    turn_id: &str,
    ordinal: usize,
    role: &str,
    items: Vec<Value>,
    error: Option<Value>,
    obj: &Value,
) -> Value {
    let msg = obj.get("message");
    let summary = if items.is_empty() {
        String::new()
    } else {
        summarize(&items)
    };
    let mut turn = Map::new();
    turn.insert("id".into(), json!(turn_id));
    turn.insert("turnId".into(), json!(turn_id));
    if let Some(message_id) = msg
        .and_then(|m| m.get("id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        turn.insert("messageId".into(), json!(message_id));
    }
    turn.insert("ordinal".into(), json!(ordinal));
    turn.insert("source".into(), json!("durable"));
    turn.insert("role".into(), json!(role));
    if let Some(ts) = obj.get("timestamp").and_then(Value::as_str) {
        turn.insert("timestamp".into(), json!(ts));
    }
    if let Some(model) = msg
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && *s != SYNTHETIC_MODEL)
    {
        turn.insert("model".into(), json!(model));
    }
    if let Some(error) = error {
        turn.insert("error".into(), error);
    }
    turn.insert("summary".into(), json!(summary));
    turn.insert("summaryKind".into(), json!(SUMMARY_KIND_ECHO));
    turn.insert("items".into(), json!(items));
    Value::Object(turn)
}

/// The model stamp the CLI writes on lines it synthesizes itself (API errors).
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// `system` lines worth showing: the compaction marker and local slash-command
/// output (`/cost`, `/context`, a failed `/compact`, F8-F10). Every other
/// system subtype (status, informational noise) stays hidden.
fn system_line_turn(obj: &Value, turn_id: &str, ordinal: usize) -> Option<Value> {
    match obj.get("subtype").and_then(Value::as_str) {
        Some("compact_boundary") => Some(compaction_marker_turn(turn_id, ordinal, obj)),
        Some("local_command") => {
            let content = obj.get("content").and_then(Value::as_str)?;
            let output = LocalCommandOutput::parse(content).unwrap_or_else(|| LocalCommandOutput {
                stdout: content.trim().to_string(),
                stderr: String::new(),
            });
            output.into_turn(turn_id, ordinal, obj)
        }
        _ => None,
    }
}

/// The system turn marking a context compaction at `obj`'s position.
pub(crate) fn compaction_marker_turn(turn_id: &str, ordinal: usize, obj: &Value) -> Value {
    turn_json(
        turn_id,
        ordinal,
        "system",
        vec![json!({ "id": format!("{turn_id}-i0"), "kind": "context_compaction" })],
        None,
        obj,
    )
}

/// A USER line whose whole text is local-command output (`<local-command-
/// stdout>Compacted </local-command-stdout>` after `/compact`) is the CLI
/// talking, not the user: project it as a system row. `None` = not such a
/// line; `Some(None)` = such a line with nothing to show.
fn local_command_user_turn(
    blocks: &[Value],
    turn_id: &str,
    ordinal: usize,
    obj: &Value,
) -> Option<Option<Value>> {
    let [block] = blocks else {
        return None;
    };
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    let output = LocalCommandOutput::parse(block.get("text").and_then(Value::as_str)?)?;
    Some(output.into_turn(turn_id, ordinal, obj))
}

/// The stdout/stderr a local slash command wrote, unwrapped from the CLI's
/// `<local-command-stdout>` / `<local-command-stderr>` envelopes.
struct LocalCommandOutput {
    stdout: String,
    stderr: String,
}

impl LocalCommandOutput {
    const STDOUT: (&'static str, &'static str) =
        ("<local-command-stdout>", "</local-command-stdout>");
    const STDERR: (&'static str, &'static str) =
        ("<local-command-stderr>", "</local-command-stderr>");

    /// `Some` only when the text consists of nothing but output envelopes.
    fn parse(text: &str) -> Option<Self> {
        let mut rest = text.trim();
        if rest.is_empty() {
            return None;
        }
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        while !rest.is_empty() {
            let (sink, (open, close)) = if rest.starts_with(Self::STDOUT.0) {
                (&mut stdout, Self::STDOUT)
            } else if rest.starts_with(Self::STDERR.0) {
                (&mut stderr, Self::STDERR)
            } else {
                return None;
            };
            let end = rest.find(close)?;
            sink.push(rest[open.len()..end].trim());
            rest = rest[end + close.len()..].trim_start();
        }
        let join = |parts: Vec<&str>| {
            parts
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        };
        Some(Self {
            stdout: join(stdout),
            stderr: join(stderr),
        })
    }

    /// stdout renders as a markdown system row; stderr as the durable
    /// `CommandError` module (stdout, when both exist, stays as the row text).
    fn into_turn(self, turn_id: &str, ordinal: usize, obj: &Value) -> Option<Value> {
        let items: Vec<Value> = if self.stdout.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "id": format!("{turn_id}-i0"), "kind": "text", "text": self.stdout })]
        };
        let error = (!self.stderr.is_empty())
            .then(|| json!({ "name": "CommandError", "message": self.stderr }));
        if items.is_empty() && error.is_none() {
            return None;
        }
        Some(turn_json(turn_id, ordinal, "system", items, error, obj))
    }
}

/// `/name args` for a persisted slash-command invocation, `None` for any
/// other text.
fn slash_command_text(text: &str) -> Option<String> {
    let text = text.trim_start();
    if !text.starts_with("<command-name>") {
        return None;
    }
    let tag = |name: &str| -> Option<&str> {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let start = text.find(&open)? + open.len();
        let end = start + text[start..].find(&close)?;
        Some(text[start..end].trim())
    };
    let name = tag("command-name").filter(|name| !name.is_empty())?;
    let name = if name.starts_with('/') {
        name.to_string()
    } else {
        format!("/{name}")
    };
    Some(match tag("command-args").filter(|args| !args.is_empty()) {
        Some(args) => format!("{name} {args}"),
        None => name,
    })
}

/// A background agent's completion notice (`origin.kind: task-notification`).
pub(crate) fn is_task_notification_line(obj: &Value) -> bool {
    obj.pointer("/origin/kind").and_then(Value::as_str) == Some("task-notification")
}

/// The text blocks of a message, joined.
fn blocks_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Flatten a tool_result block's content (string, or array of text/image
/// parts) to a string; image parts become the `[image]` placeholder.
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| match p.get("type").and_then(Value::as_str) {
                Some("image") => Some(IMAGE_PLACEHOLDER),
                _ => p.get("text").and_then(Value::as_str),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Turn summary: first non-empty `text` item's text, falling back to the first
/// non-empty `thinking` item's text (char-safe truncate to the shared
/// [`SUMMARY_MAX_CHARS`] policy), else a tool label -- `FreshAgentTurnSchema.summary`
/// is REQUIRED. Text is preferred over thinking so an assistant turn's summary
/// is its visible answer, not its reasoning preamble (golden fixture turn 1:
/// items `[thinking "pondering", text "first answer"]` must summarize to
/// `"first answer"`). Every claude summary is a mechanical projection of the
/// turn's own items, so every claude turn tags `summaryKind: "echo"`.
pub(crate) fn summarize(items: &[Value]) -> String {
    let first_text_of = |kind: &str| -> Option<String> {
        items.iter().find_map(|item| {
            if item.get("kind").and_then(Value::as_str) != Some(kind) {
                return None;
            }
            let trimmed = item.get("text").and_then(Value::as_str)?.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(truncate_summary(trimmed))
            }
        })
    };
    if let Some(summary) = first_text_of("text").or_else(|| first_text_of("thinking")) {
        return summary;
    }
    for item in items {
        match item.get("kind").and_then(Value::as_str) {
            Some("tool_use") => {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    // Tool names count as summaries too: the shared 140-char
                    // policy MUST apply here (one Rust-side truncation policy
                    // for every summary arm — fresh-eyes round 1, Finding 2).
                    return truncate_summary(name);
                }
            }
            Some("tool_result") => {
                let is_error = item
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                return if is_error {
                    TOOL_ERROR_LABEL
                } else {
                    TOOL_RESULT_LABEL
                }
                .to_string();
            }
            Some("task_delegation") => {
                if let Some(title) = item.get("title").and_then(Value::as_str) {
                    return truncate_summary(title);
                }
            }
            Some("context_compaction") => return CONTEXT_COMPACTED_LABEL.to_string(),
            _ => {}
        }
    }
    "[claude turn]".to_string()
}

// ── kata 1wxv Task 4: raw parentUuid-chain math (rollback resume math) ────────
//
// Stage-2-verified SDK semantics (the fork-at-point contract):
// * `resumeSessionAt` keeps messages up to AND INCLUDING the named uuid along
//   the RAW parentUuid chain — including lines the display parser filters out
//   (tool_result carriers, sidechain/meta lines, structured_output carriers).
//   Chain POSITION is therefore always computed over the raw links; display
//   filtering applies ONLY to the removed-turns PROJECTION.
// * Transcript matching for LCP/markers compares `uuid` + `message` content
//   ONLY, skips fork bookend line kinds (`mode`, `atis-latch`,
//   `queue-operation`, `last-prompt`), and never compares sessionId/entrypoint/
//   gitBranch/promptId (a fork rewrites those on the kept prefix lines).
// * The child preserves original uuid/parentUuid for prefix lines (the LCP and
//   marker math rely on it).

/// One parsed chain carrier: uuid + raw parent link + the whole line value.
#[derive(Clone)]
struct ChainLine {
    uuid: String,
    parent: Option<String>,
    obj: Value,
}

/// Fork header/tail line kinds (Stage-2 verified): they bookend a fork's
/// transcript and never carry conversation truth — skipped for chain membership,
/// tip, and LCP matching.
const FORK_BOOKEND_KINDS: [&str; 4] = ["mode", "atis-latch", "queue-operation", "last-prompt"];

/// Parse every uuid-bearing line (skipping fork bookend kinds), in file order.
fn parse_chain_candidates(transcript: &str) -> Vec<ChainLine> {
    let mut out = Vec::new();
    for line in transcript.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(uuid) = obj
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if FORK_BOOKEND_KINDS.contains(&kind) {
            continue;
        }
        let parent = obj
            .get("parentUuid")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        out.push(ChainLine {
            uuid: uuid.to_string(),
            parent,
            obj,
        });
    }
    out
}

/// The raw parentUuid chain, root→tip: start at the LAST candidate line in file
/// order (claude appends — the tail is the live tip) and walk parentUuid links
/// to the root. Lines whose parent link dangles (relink/compaction edges) end
/// the walk — the observable chain of the LIVE conversation; orphan branches
/// never enter it.
fn raw_chain(transcript: &str) -> Vec<ChainLine> {
    let candidates = parse_chain_candidates(transcript);
    let Some(tip) = candidates.last().map(|l| l.uuid.clone()) else {
        return Vec::new();
    };
    chain_ending_at(&candidates, &tip)
}

/// The raw parentUuid chain root→`end` over parsed `candidates` (the walk
/// [`raw_chain`] runs from the tip): empty when `end` is not a candidate.
fn chain_ending_at(candidates: &[ChainLine], end: &str) -> Vec<ChainLine> {
    let mut cur = end.to_string();
    let by_uuid: std::collections::HashMap<&str, &ChainLine> =
        candidates.iter().map(|l| (l.uuid.as_str(), l)).collect();
    let mut reversed = Vec::new();
    let mut seen = std::collections::HashSet::new(); // defensive against a relinked cycle
    while let Some(line) = by_uuid.get(cur.as_str()) {
        if !seen.insert(line.uuid.clone()) {
            break;
        }
        reversed.push((*line).clone());
        match &line.parent {
            Some(p) => cur = p.clone(),
            None => break,
        }
    }
    reversed.reverse();
    reversed
}

/// The conversation a lazy fork of `parent` holds through `at` (inclusive; all
/// of it when `None`), before the fork writes its own transcript (design §4.5,
/// T6): `parent`'s lines on the raw parentUuid chain ending at `at`, verbatim
/// and in file order. A fork keeps those lines' uuids, so the turns projected
/// from this text keep their ids when the fork's transcript appears. `None`
/// when `at` is not a line of `parent` (the CLI refuses that fork:
/// `RESUME_POINT_NOT_FOUND`).
pub(crate) fn fork_prefix_transcript(parent: &str, at: Option<&str>) -> Option<String> {
    let chain = match at {
        Some(at) => {
            let candidates = parse_chain_candidates(parent);
            if !candidates.iter().any(|line| line.uuid == at) {
                return None;
            }
            chain_ending_at(&candidates, at)
        }
        None => raw_chain(parent),
    };
    let members: std::collections::HashSet<&str> =
        chain.iter().map(|line| line.uuid.as_str()).collect();
    let kept: Vec<&str> = parent
        .lines()
        .filter(|line| {
            serde_json::from_str::<Value>(line.trim())
                .ok()
                .and_then(|obj| obj.get("uuid").and_then(Value::as_str).map(str::to_string))
                .is_some_and(|uuid| members.contains(uuid.as_str()))
        })
        .collect();
    Some(kept.join("\n"))
}

/// The last uuid of the raw parentUuid chain (the "chain tip") — the redo
/// contract's recorded anchor (`original_tip_uuid`). `None` when the transcript
/// carries no chain lines at all (e.g. the fresh conversation after a first-turn
/// undo — the r2 empty-tip leg).
pub(crate) fn raw_chain_tip(transcript: &str) -> Option<String> {
    raw_chain(transcript).last().map(|l| l.uuid.clone())
}

/// Chain-entry equality for LCP: `uuid` + `message` content ONLY (never
/// sessionId/entrypoint/gitBranch/promptId — a fork rewrites those metadata
/// fields on the kept prefix lines).
fn chain_entries_match(a: &ChainLine, b: &ChainLine) -> bool {
    a.uuid == b.uuid && a.obj.get("message") == b.obj.get("message")
}

/// The uuid ending the common raw-chain prefix of `current` and `original`
/// (`None` when nothing matches — the vacuous empty-current case). The redo
/// validity contract requires this to equal `raw_chain_tip(current)`: the
/// current chain must still be a strict prefix of the chain-root original.
pub(crate) fn raw_lcp_end(current: &str, original: &str) -> Option<String> {
    let cur = raw_chain(current);
    let orig = raw_chain(original);
    let mut end = None;
    for (c, o) in cur.iter().zip(orig.iter()) {
        if !chain_entries_match(c, o) {
            break;
        }
        end = Some(c.uuid.clone());
    }
    end
}

/// The `resumeDropsTurn` guard for a fork of `transcript` that keeps its raw
/// chain through `keep` (core design §4.2, decision 2): the uuid of the one
/// prompted turn the fork discards, so the CLI refuses the fork
/// (`FORK_GUARD_REFUSED`) when that turn absorbed a send or a task
/// notification the pane never showed as its own turn. `None` (no guard, the
/// SDK's unvalidated truncation) when the fork discards nothing, starts its
/// discard mid-turn, discards more than one turn (the CLI's guard declares
/// exactly one: a second prompt in the range always refuses), discards a
/// slash command's step (the CLI does not attribute the command's output line
/// to it), or boots fresh (`keep` is `None`).
pub(crate) fn drops_turn_guard(transcript: &str, keep: Option<&str>) -> Option<String> {
    let keep = keep?;
    let chain = raw_chain(transcript);
    let kept = chain.iter().position(|line| line.uuid == keep)?;
    let (first, rest) = chain.get(kept + 1..)?.split_first()?;
    (is_prompt_anchor(&first.obj) && !rest.iter().any(|line| is_rollback_anchor(&line.obj)))
        .then(|| first.uuid.clone())
}

/// A rollback ANCHOR (core design §4.5, transcript plan N7): a line that
/// starts a turn the pane renders as the user's. The one predicate every
/// rollback step and the transcript projector share: a real prompt anchors,
/// and so does a slash-command invocation (`<command-name>/x</command-name>`,
/// rendered as what the user typed). The CLI's own lines never do: the
/// local-command caveat and other meta lines, sidechain lines, the compaction
/// summary ([`is_synthetic_line`], which the projector skips), a command's
/// `<local-command-stdout|stderr>` output (projected as a system row), a task
/// notification (folded into its delegation), and a tool-result carrier.
pub(crate) fn is_rollback_anchor(obj: &Value) -> bool {
    if obj.get("type").and_then(Value::as_str) != Some("user")
        || is_synthetic_line(obj)
        || is_task_notification_line(obj)
    {
        return false;
    }
    let blocks: Vec<Value> = match obj.get("message") {
        Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
        Some(Value::Object(m)) => match m.get("content") {
            Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
            Some(Value::Array(blocks)) => blocks.clone(),
            _ => return false,
        },
        _ => return false,
    };
    if local_command_user_turn(&blocks, "", 0, obj).is_some() {
        return false;
    }
    blocks
        .iter()
        .any(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => b
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|t| !t.trim().is_empty()),
            Some("image") => true,
            _ => false,
        })
}

/// A rollback anchor that is a prompt to the model, not a slash command.
fn is_prompt_anchor(obj: &Value) -> bool {
    is_rollback_anchor(obj) && slash_command_text(&user_prompt_text(obj)).is_none()
}

/// The anchor line's plain prompt text (the composer-refill payload): a plain
/// string message, a `{content: "string"}`, or its text blocks joined.
fn user_prompt_text(obj: &Value) -> String {
    match obj.get("message") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(m)) => match m.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

/// What the user typed to start the anchor's step (the composer refill): the
/// prompt text, or the slash command as typed (`/compact keep it short`).
fn anchor_refill_text(obj: &Value) -> String {
    let text = user_prompt_text(obj);
    slash_command_text(&text).unwrap_or(text)
}

/// Chain positions of every rollback anchor, in chain order (the step starts).
fn rollback_anchor_positions(chain: &[ChainLine]) -> Vec<usize> {
    chain
        .iter()
        .enumerate()
        .filter_map(|(i, l)| is_rollback_anchor(&l.obj).then_some(i))
        .collect()
}

/// The chain position that ENDS the step starting at `anchors[step_idx]` —
/// the last entry before the next step's anchor (or the tip).
fn step_group_end(chain_len: usize, anchors: &[usize], step_idx: usize) -> usize {
    anchors
        .get(step_idx + 1)
        .map(|next| next.saturating_sub(1))
        .unwrap_or(chain_len.saturating_sub(1))
}

/// The rollback target: one turn-step (`Step`) or "undo to here" (`ToTurn`,
/// carrying the addressed turn id).
pub(crate) enum ResumeTarget {
    Step,
    ToTurn(String),
}

/// One resolved rollback: where the fork keeps (`resume_at_uuid`; `None` =
/// "before the first message" — LEGAL per r2: the handler takes the
/// fresh-conversation leg, never a refusal), the removed display-turn slice
/// (the marker bucket + ack payload), and the composer-refill prompt. The
/// fork's `resumeDropsTurn` guard comes from [`drops_turn_guard`] over the
/// transcript the fork actually reads.
pub(crate) struct ResumePoint {
    pub resume_at_uuid: Option<String>,
    pub removed_turns: Vec<Value>,
    pub prompt_text: String,
}

#[derive(Debug)]
pub(crate) enum ResumeResolveError {
    /// No chain lines / no user step — nothing to roll back.
    Empty,
    /// The addressed turn id (or a pre-first-anchor chain member) is not in
    /// this conversation.
    TargetNotFound,
}

/// Resolve the rollback fork point over the RAW parentUuid chain (correction
/// item 3: the display-predecessor variant is VOID — display filtering applies
/// only to the removed-turns projection). A STEP is one user-anchor line plus
/// every raw line until the next user anchor, in raw-chain order; `Step` picks
/// the last step, `ToTurn` the step containing (or starting at) the addressed
/// uuid — an addressed ASSISTANT uuid maps to its owning user step (the last
/// user anchor at-or-before it along the chain).
pub(crate) fn resolve_resume_point(
    transcript: &str,
    thread_id: &str,
    target: ResumeTarget,
) -> Result<ResumePoint, ResumeResolveError> {
    let chain = raw_chain(transcript);
    if chain.is_empty() {
        return Err(ResumeResolveError::Empty);
    }
    let anchors = rollback_anchor_positions(&chain);
    if anchors.is_empty() {
        return Err(ResumeResolveError::Empty);
    }
    let first_remove_pos = match target {
        ResumeTarget::Step => *anchors.last().expect("anchors non-empty"),
        ResumeTarget::ToTurn(id) => {
            let pos = chain
                .iter()
                .position(|l| l.uuid == id)
                .ok_or(ResumeResolveError::TargetNotFound)?;
            // The owning user step: the last user anchor AT-OR-BEFORE pos.
            anchors
                .iter()
                .rev()
                .find(|&&a| a <= pos)
                .copied()
                .ok_or(ResumeResolveError::TargetNotFound)?
        }
    };
    // The keep point is the step first line's raw-chain predecessor — `None`
    // when the step IS the chain head ("BEFORE THE FIRST MESSAGE", legal per r2).
    // predecessor == the raw parentUuid of the first-to-remove line, by
    // construction of the chain walk.
    let resume_at_uuid = if first_remove_pos == 0 {
        None
    } else {
        Some(chain[first_remove_pos - 1].uuid.clone())
    };
    // The removed slice's DISPLAY projection (display filtering applies HERE).
    let removed_uuids: std::collections::HashSet<&str> = chain[first_remove_pos..]
        .iter()
        .map(|l| l.uuid.as_str())
        .collect();
    let removed_turns: Vec<Value> = parse_transcript_turns(thread_id, transcript)
        .into_iter()
        .filter(|t| {
            t.get("turnId")
                .and_then(Value::as_str)
                .is_some_and(|id| removed_uuids.contains(id))
        })
        .collect();
    let prompt_text = anchor_refill_text(&chain[first_remove_pos].obj);
    Ok(ResumePoint {
        resume_at_uuid,
        removed_turns,
        prompt_text,
    })
}

/// Why a fork of a conversation has no point to keep through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ForkPointError {
    /// The conversation holds no chain lines: there is nothing to fork.
    Empty,
    /// The turn the fork was asked to start from is not in the conversation.
    TurnNotFound,
}

/// Where a fork of `transcript` keeps through (core design §4.5 `handle_fork`):
/// the last raw-chain entry of the step holding `at_turn_id`, so the fork keeps
/// that whole turn (its answer and tool round trips), or the chain's tip when no
/// turn is named. `at_turn_id` is a snapshot turn id (a line uuid); a client
/// split-row id (`<turn>:row-<n>`) names its turn. A line before the first step
/// keeps the lines before that step.
pub(crate) fn fork_point(
    transcript: &str,
    at_turn_id: Option<&str>,
) -> Result<String, ForkPointError> {
    let chain = raw_chain(transcript);
    let Some(tip) = chain.last() else {
        return Err(ForkPointError::Empty);
    };
    let Some(at) = at_turn_id else {
        return Ok(tip.uuid.clone());
    };
    let at = strip_split_row_suffix(at);
    let pos = chain
        .iter()
        .position(|line| line.uuid == at)
        .ok_or(ForkPointError::TurnNotFound)?;
    let anchors = rollback_anchor_positions(&chain);
    let end = match anchors.iter().rposition(|&anchor| anchor <= pos) {
        Some(step) => step_group_end(chain.len(), &anchors, step),
        None => anchors
            .first()
            .map(|first| first.saturating_sub(1))
            .unwrap_or(chain.len() - 1),
    };
    Ok(chain[end].uuid.clone())
}

/// A turn id without the client's split-row suffix (`<turn>:row-<digits>`).
fn strip_split_row_suffix(turn_id: &str) -> &str {
    match turn_id.rsplit_once(":row-") {
        Some((turn, digits))
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) =>
        {
            turn
        }
        _ => turn_id,
    }
}

/// The restored slice's display turns + the composer-refill prompt: the display
/// projection of the original's chain range strictly-after-the-current-prefix
/// through `resume_at` (inclusive), with the prompt of the first restored step.
pub(crate) struct RestoredSlice {
    pub turns: Vec<Value>,
    pub prompt_text: String,
}

pub(crate) fn restored_slice_turns(
    original: &str,
    current: &str,
    resume_at: &str,
) -> RestoredSlice {
    let orig = raw_chain(original);
    let cur = raw_chain(current);
    let Some(end_pos) = orig.iter().position(|l| l.uuid == resume_at) else {
        return RestoredSlice {
            turns: Vec::new(),
            prompt_text: String::new(),
        };
    };
    // `current` is a validated PREFIX of the original (the tip+LCP contract),
    // so the restored range starts exactly at cur.len().
    let start_pos = cur.len();
    if start_pos > end_pos {
        return RestoredSlice {
            turns: Vec::new(),
            prompt_text: String::new(),
        };
    }
    let slice_uuids: std::collections::HashSet<&str> = orig[start_pos..=end_pos]
        .iter()
        .map(|l| l.uuid.as_str())
        .collect();
    let turns: Vec<Value> = parse_transcript_turns("", original)
        .into_iter()
        .filter(|t| {
            t.get("turnId")
                .and_then(Value::as_str)
                .is_some_and(|id| slice_uuids.contains(id))
        })
        .collect();
    let anchors = rollback_anchor_positions(&orig);
    let prompt_text = anchors
        .iter()
        .find(|&&a| a >= start_pos && a <= end_pos)
        .map(|&a| anchor_refill_text(&orig[a].obj))
        .unwrap_or_default();
    RestoredSlice { turns, prompt_text }
}

/// The redo resume point (r3 boundary rule): the LAST raw-chain uuid of the
/// step being restored — its assistant tail — never the next turn's first uuid
/// (`resumeSessionAt` keeps through-AND-including the named uuid; resuming at
/// the step's OWN first uuid would restore only the bare prompt, breaking
/// undo↔redo invertibility).
///
/// `Ok(Some(uuid))` — resume at this uuid. `Ok(None)` — nothing to redo (the
/// kept prefix already reaches the original's tip). `Err(msg)` — a toTurn
/// target that is unknown to the original or already inside the kept prefix.
pub(crate) fn redo_resume_target(
    original: &str,
    current: &str,
    op: &crate::rollback_record::RollbackRequest,
) -> Result<Option<String>, String> {
    use crate::rollback_record::RollbackModeReq;
    let orig = raw_chain(original);
    let cur = raw_chain(current);
    let anchors = rollback_anchor_positions(&orig);
    match op.mode {
        RollbackModeReq::Step => match cur.last() {
            // r2 first-turn case: the current chain is EMPTY; restore the first
            // step's whole group (its end = the LAST uuid of that group — a1
            // for u1/a1, NEVER the first user anchor u1).
            None => {
                if anchors.is_empty() {
                    return Ok(None);
                }
                let end = step_group_end(orig.len(), &anchors, 0);
                Ok(Some(orig[end].uuid.clone()))
            }
            Some(tip) => {
                let pos = orig
                    .iter()
                    .position(|l| l.uuid == tip.uuid)
                    .ok_or_else(|| "the current chain diverged from the original".to_string())?;
                if pos + 1 >= orig.len() {
                    return Ok(None); // prefix == original: nothing to redo
                }
                // The step CONTAINING the next chain entry (post-fork, pos+1
                // is exactly the removed step's anchor; the general lookup
                // keeps this honest for LCP-shortened prefixes too).
                let step_idx = anchors
                    .iter()
                    .rposition(|&a| a <= pos + 1)
                    .ok_or_else(|| "no user step lies beyond the kept prefix".to_string())?;
                let end = step_group_end(orig.len(), &anchors, step_idx);
                Ok(Some(orig[end].uuid.clone()))
            }
        },
        RollbackModeReq::ToTurn => {
            let id = op
                .turn_id
                .as_deref()
                .ok_or_else(|| "redo toTurn requires a turnId".to_string())?;
            let pos = orig
                .iter()
                .position(|l| l.uuid == id)
                .ok_or_else(|| format!("turn {id:?} is not in the original conversation"))?;
            let step_idx = anchors
                .iter()
                .rposition(|&a| a <= pos)
                .ok_or_else(|| format!("turn {id:?} is not in any user step"))?;
            let end = step_group_end(orig.len(), &anchors, step_idx);
            if end < cur.len() {
                return Err(format!(
                    "turn {id:?} already lies inside the kept prefix — nothing to restore"
                ));
            }
            Ok(Some(orig[end].uuid.clone()))
        }
    }
}

/// The canRedo chain-root RECHECK (kata 1wxv Task 5): the stored bit is a
/// necessary but NOT sufficient condition — the CURRENT-epoch redo state comes
/// from the chain root, so when `original_session_id` resolves, the original's
/// raw-chain tip is RE-READ at snapshot time and must equal the recorded tip;
/// a moved tip (or a compacted/GC'd/unreadable original, or a mismatching
/// recorded tip) forces `canRedo:false` so no device shows a redo that Task 4
/// would refuse with `REDO_UNAVAILABLE` + `REDO_REMOVED_HISTORY_COPY`. A record
/// without an `original_session_id` keeps the stored bit as-is.
fn claude_can_redo_now(record: &crate::rollback_record::RollbackRecord) -> bool {
    if !record.can_redo() {
        return false;
    }
    let Some(original) = record.original_session_id.as_deref() else {
        return true;
    };
    let tip = locate_transcript(original)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| raw_chain_tip(&text));
    tip == record.original_tip_uuid
}

/// Build the `FreshAgentSnapshotSchema`-exact JSON (`shared/fresh-agent-contract.ts:230-246`,
/// zod `.strict()` -- every key here is either required or schema-known; NOTHING extra —
/// the kata 1wxv keys (`undo`/`redo`/`rolledBackTurns`/`rollback`/`rolledBack`) are
/// the schema's OPTIONAL additions).
pub(crate) fn build_claude_snapshot_json(
    session_type: &str,
    thread_id: &str,
    transcript: &str,
    revision: i64,
    // Kata 1wxv Task 5: the durable rollback record (None when the session never
    // rolled back through this server's ledger).
    rollback: Option<&crate::rollback_record::RollbackRecord>,
) -> Value {
    let projection =
        crate::claude_projection::ClaudeTranscriptProjector::project(thread_id, transcript);
    build_claude_snapshot_from_projection(session_type, thread_id, projection, revision, rollback)
}

/// [`build_claude_snapshot_json`] over an already-built projection (the served
/// snapshot projects off the async runtime, with subagent activity).
pub(crate) fn build_claude_snapshot_from_projection(
    session_type: &str,
    thread_id: &str,
    projection: crate::claude_projection::ClaudeProjection,
    revision: i64,
    rollback: Option<&crate::rollback_record::RollbackRecord>,
) -> Value {
    let crate::claude_projection::ClaudeProjection {
        turns,
        diffs,
        token_usage,
        transcript_line_uuids,
    } = projection;
    let latest_turn_id = turns
        .last()
        .and_then(|t| t.get("turnId"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut snapshot = json!({
        "sessionType": session_type,
        "provider": "claude",
        "threadId": thread_id,
        "sessionId": thread_id,
        "revision": revision.max(0),
        "latestTurnId": latest_turn_id,
        // Deliberate divergence from codex (which serves live status from session
        // state): this adapter is disk-only and always reports "idle" -- live status
        // is authoritative via the WS status events, so the client ignores this on
        // live sessions.
        "status": "idle",
        "capabilities": {
            "send": true,
            "interrupt": true,
            "approvals": false,
            "questions": false,
            // C14 (G09): a conversation forks (`FreshClaudeState::handle_fork`).
            // The server refuses a fork while a turn runs (BUSY_TURN).
            "fork": true,
            // The changed-files panel shows when the transcript edited files.
            "diffs": !diffs.is_empty(),
            // Kata 1wxv Task 5: STATIC stamps (freshclaude AND kilroy — no SDK
            // capability query exists); an old-CLI runtime failure classifies to
            // UNSUPPORTED_CAPABILITY refusal at op time, never at stamp time.
            "undo": true,
            "redo": true,
            // kata z7j7: model/effort/permissionMode apply per-send via the
            // configure frame (configure_for_send); sandbox has no claude-side concept.
            "settingScopes": {
                "model": "per-send",
                "effort": "per-send",
                "permissionMode": "per-send",
                "sandbox": "unsupported",
            },
        },
        "tokenUsage": token_usage,
        "pendingApprovals": [],
        "pendingQuestions": [],
        "worktrees": [],
        "diffs": diffs,
        "childThreads": [],
        "turns": turns,
        // The newest transcript line uuids, including lines that produce no
        // turn (absorbed results, hidden bookkeeping): the live tail's landing
        // check (transcript-live plan §4.4).
        "extensions": { "claude": { "transcriptLineUuids": transcript_line_uuids } },
    });
    if let Some(record) = rollback {
        // The marker bucket is LEDGER-SOURCED (r3): the record's entries union —
        // frozen prior epochs first, then the current epoch's recorded slice —
        // durable even if an old original's JSONL is later compacted/GC'd
        // (decision 6's "persist marked"). `canRedo` is provider-adjudicated:
        // the stored bit AND the chain-root tip recheck. The record also doubles
        // as the revision floor: a stale transcript basis never lets the client's
        // monotonic watermark drop the post-rollback snapshot.
        let floored = crate::rollback_record::stamp_rollback_snapshot(
            &mut snapshot,
            revision.max(0),
            record,
            claude_can_redo_now(record),
        );
        snapshot["revision"] = json!(floored);
    }
    snapshot
}

/// Locate + read + build over this process's store roots, for a session with
/// no genesis. The served snapshot goes through the claude lane
/// (`FreshClaudeState::disk_snapshot`), which reads its own store and the
/// session's genesis; tests use this one.
#[cfg(test)]
pub(crate) async fn get_claude_snapshot(
    session_type: &str,
    thread_id: &str,
    rollback: Option<&crate::rollback_record::RollbackRecord>,
) -> Result<Value, ClaudeSnapshotError> {
    get_claude_snapshot_in(
        &claude_home_candidates(),
        session_type,
        thread_id,
        None,
        rollback,
    )
    .await
}

/// A session's snapshot, from the conversation it holds (design §4.5's
/// "effective transcript"): its own transcript when it has one; otherwise its
/// genesis's (nothing for `Fresh`, the parent's prefix for a pending `Fork`); a
/// clean miss with no genesis is gone (404 lost session), and a store that
/// could not be checked is never gone (500).
///
/// `revision` = the transcript's mtime in ms (monotonic as the file grows --
/// `mergeSnapshotForDisplay` DROPS revision regressions), fallback turn count;
/// a pending session's is its binding row's last write. Kata 1wxv Task 5 floors
/// either at the rollback record's `lastOpAtMs`.
pub(crate) async fn get_claude_snapshot_in(
    roots: &[PathBuf],
    session_type: &str,
    thread_id: &str,
    genesis: Option<&crate::identity_sink::RecordedGenesis>,
    rollback: Option<&crate::rollback_record::RollbackRecord>,
) -> Result<Value, ClaudeSnapshotError> {
    let path = match locate_transcript_state_in(roots, thread_id) {
        TranscriptLocation::Found(path) => path,
        // Clean miss in EVERY candidate root: the genesis, when the session has
        // one, says what it holds before its transcript exists; without one the
        // store positively does not know it => 404 (ledger A3/A4).
        TranscriptLocation::Absent => {
            return match genesis {
                Some(recorded) => {
                    pending_snapshot(roots, session_type, thread_id, recorded, rollback).await
                }
                None => Err(ClaudeSnapshotError::NotFound),
            };
        }
        // Cannot check => must not deny (the attach arm in claude.rs treats this
        // exact state as Transient): no store root, or a store read error, cannot
        // assert the session is gone, so this is Io (-> 500), never NotFound
        // (-> 404 lost).
        TranscriptLocation::Unreadable(error) => {
            log_transcript_unreadable("snapshot", thread_id, &error);
            return Err(ClaudeSnapshotError::Io(error.to_string()));
        }
    };
    let (mtime_ms, projection) = project_transcript_file(path, thread_id, None).await?;
    let mut snapshot =
        build_claude_snapshot_from_projection(session_type, thread_id, projection, 0, rollback);
    let turn_count = snapshot["turns"]
        .as_array()
        .map(|a| a.len() as i64)
        .unwrap_or(0);
    let basis = mtime_ms.unwrap_or(turn_count).max(0);
    snapshot["revision"] = json!(rollback_floor(basis, rollback));
    Ok(snapshot)
}

/// The snapshot of a session whose transcript does not exist yet (design §4.3,
/// §4.5): a `Fresh` one holds nothing; a pending `Fork` holds its parent's
/// conversation through the fork point, with the parent's turn ids (the fork
/// keeps them, T6). A fork whose parent is gone, or no longer holds the fork
/// point, cannot boot (the CLI refuses it), so its session is gone too.
async fn pending_snapshot(
    roots: &[PathBuf],
    session_type: &str,
    thread_id: &str,
    recorded: &crate::identity_sink::RecordedGenesis,
    rollback: Option<&crate::rollback_record::RollbackRecord>,
) -> Result<Value, ClaudeSnapshotError> {
    use crate::claude_launch::ClaudeGenesis;
    let projection = match &recorded.genesis {
        ClaudeGenesis::Fresh => {
            crate::claude_projection::ClaudeTranscriptProjector::project(thread_id, "")
        }
        ClaudeGenesis::Fork { parent, at, .. } => {
            let parent_path = match locate_transcript_state_in(roots, parent) {
                TranscriptLocation::Found(path) => path,
                TranscriptLocation::Absent => {
                    log_pending_fork_unservable(thread_id, parent, at.as_deref(), "parent_absent");
                    return Err(ClaudeSnapshotError::NotFound);
                }
                TranscriptLocation::Unreadable(error) => {
                    log_transcript_unreadable("pending_fork_snapshot", parent, &error);
                    return Err(ClaudeSnapshotError::Io(error.to_string()));
                }
            };
            match project_transcript_file(parent_path, thread_id, Some(at.clone())).await {
                Ok((_, projection)) => projection,
                Err(ClaudeSnapshotError::NotFound) => {
                    log_pending_fork_unservable(
                        thread_id,
                        parent,
                        at.as_deref(),
                        "fork_point_absent",
                    );
                    return Err(ClaudeSnapshotError::NotFound);
                }
                Err(error) => return Err(error),
            }
        }
    };
    tracing::debug!(
        component = "freshagent.claude",
        event = "freshagent.claude.pending_snapshot",
        session_id = %thread_id,
        genesis = recorded.genesis.kind(),
        turns = projection.turns.len(),
        "served the snapshot of a session whose transcript does not exist yet from its genesis"
    );
    let mut snapshot =
        build_claude_snapshot_from_projection(session_type, thread_id, projection, 0, rollback);
    snapshot["revision"] = json!(rollback_floor(recorded.updated_at_ms.max(0), rollback));
    Ok(snapshot)
}

/// Read and project the transcript at `path` as `thread_id`'s, with its
/// subagent activity, off the async runtime. `fork_at` projects only the
/// conversation a lazy fork of it holds ([`fork_prefix_transcript`]); a fork
/// point the transcript does not hold answers `NotFound`.
async fn project_transcript_file(
    path: PathBuf,
    thread_id: &str,
    fork_at: Option<Option<String>>,
) -> Result<(Option<i64>, crate::claude_projection::ClaudeProjection), ClaudeSnapshotError> {
    let thread = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        let mtime_ms = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let content = std::fs::read_to_string(&path)
            .map_err(|error| ClaudeSnapshotError::Io(error.to_string()))?;
        let content = match fork_at {
            None => content,
            Some(at) => fork_prefix_transcript(&content, at.as_deref())
                .ok_or(ClaudeSnapshotError::NotFound)?,
        };
        let subagents = crate::claude_projection::FsSubagents::for_transcript(&path);
        let projection = crate::claude_projection::ClaudeTranscriptProjector::project_with(
            &thread, &content, &subagents,
        );
        Ok((mtime_ms, projection))
    })
    .await
    .map_err(|e| ClaudeSnapshotError::Io(e.to_string()))?
}

/// `basis` floored at the rollback record's last operation (kata 1wxv Task 5).
fn rollback_floor(basis: i64, rollback: Option<&crate::rollback_record::RollbackRecord>) -> i64 {
    match rollback {
        Some(record) => basis.max(record.last_op_at_ms),
        None => basis,
    }
}

/// One warn when a pending fork's snapshot cannot be served because the
/// conversation it forks is not there to fork.
fn log_pending_fork_unservable(thread_id: &str, parent: &str, at: Option<&str>, reason: &str) {
    tracing::warn!(
        component = "freshagent.claude",
        event = "freshagent.claude.pending_fork_unservable",
        session_id = %thread_id,
        parent = %parent,
        at = ?at,
        reason,
        "a pending fork's parent conversation does not hold the fork point; the session reads as gone"
    );
}

/// Task 3 (reload-while-pending): overlay a session's LIVE pending approvals/questions
/// onto the disk-built snapshot — the legacy `normalizeClaudeThreadSnapshot` behavior
/// (`normalize.ts:186-204`: `pendingApprovals`/`pendingQuestions` come from the live
/// session, not the transcript). The `capabilities.approvals`/`capabilities.questions`
/// gates are driven by PRESENCE OF PENDING (`normalize.ts:226-232`), never by provider
/// capability constants. Entry values arrive already in the `.strict()` contract shape
/// ([`crate::claude::FreshClaudeState::snapshot_pending_overlay`] builds them); this fn
/// stamps them verbatim. An EMPTY overlay re-stamps the same empty arrays + false gates
/// the builder produces, so the no-pending output stays byte-identical to the golden
/// fixture (`builder_output_matches_the_golden_snapshot_fixture`).
pub(crate) fn apply_pending_overlay(
    snapshot: &mut Value,
    approvals: Vec<Value>,
    questions: Vec<Value>,
) {
    snapshot["capabilities"]["approvals"] = json!(!approvals.is_empty());
    snapshot["capabilities"]["questions"] = json!(!questions.is_empty());
    snapshot["pendingApprovals"] = Value::Array(approvals);
    snapshot["pendingQuestions"] = Value::Array(questions);
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn fresh_agent_operation_matrix_parity_claude_and_kilroy() {
        for session_type in ["freshclaude", "kilroy"] {
            let snapshot = build_claude_snapshot_json(session_type, "native", "", 0, None);
            assert_eq!(snapshot["sessionType"], session_type);
            assert_eq!(snapshot["capabilities"]["send"], true);
            assert_eq!(snapshot["capabilities"]["interrupt"], true);
            // C14 (G09): a claude conversation forks (`FreshClaudeState::handle_fork`).
            assert_eq!(snapshot["capabilities"]["fork"], true);
            assert_eq!(snapshot["capabilities"]["undo"], true);
            assert_eq!(snapshot["capabilities"]["redo"], true);
        }
    }

    fn temp_home() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn find_transcript_locates_a_direct_project_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-home-user-proj");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("11111111-1111-4111-8111-111111111111.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "11111111-1111-4111-8111-111111111111"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_locates_a_one_level_nested_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-p").join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "22222222-2222-4222-8222-222222222222"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_misses_cleanly_and_rejects_traversal() {
        let home = temp_home();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        assert_eq!(
            find_transcript(home.path(), "33333333-3333-4333-8333-333333333333"),
            None
        );
        assert_eq!(find_transcript(home.path(), "../etc/passwd"), None);
        assert_eq!(find_transcript(home.path(), "a/b"), None);
        assert_eq!(find_transcript(home.path(), ""), None);
    }

    #[test]
    fn transcript_cwd_reads_the_first_cwd_field() {
        let home = temp_home();
        let file = home.path().join("t.jsonl");
        std::fs::write(
            &file,
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/home/user/proj\",\"message\":\"hi\"}\n",
        )
        .unwrap();
        assert_eq!(transcript_cwd(&file), Some("/home/user/proj".to_string()));
        let empty = home.path().join("e.jsonl");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(transcript_cwd(&empty), None);
    }

    #[test]
    fn transcript_cwd_bounded_never_scans_past_the_64kib_prefix() {
        // Node parity (`CWD_SCAN_BYTES`, `claude-transcript-locator.ts`): a
        // cwd line that begins beyond the first 64 KiB is invisible to the
        // resolve fallback's bounded reader — while the unbounded
        // `transcript_cwd` (other consumers) still finds it. Also covers the
        // boundary-straddling case: the line cut at the 64 KiB edge is a
        // truncated fragment that fails to parse and is skipped, like Node's
        // JSON.parse catch.
        let home = temp_home();
        let file = home.path().join("big.jsonl");
        let filler_line = "{\"type\":\"noise\"}\n";
        let mut content = String::new();
        while content.len() <= 64 * 1024 {
            content.push_str(filler_line);
        }
        content.push_str("{\"type\":\"user\",\"cwd\":\"/beyond/prefix\"}\n");
        std::fs::write(&file, &content).unwrap();
        assert_eq!(transcript_cwd_bounded(&file), None);
        assert_eq!(transcript_cwd(&file), Some("/beyond/prefix".to_string()));
    }

    #[test]
    fn transcript_cwd_bounded_parses_a_complete_unterminated_final_line() {
        // Node's `head.split('\n')` loop has no discard-the-tail rule: a
        // COMPLETE final line with no trailing newline (small transcript)
        // still parses. Do not drop the final segment.
        let home = temp_home();
        let file = home.path().join("small.jsonl");
        std::fs::write(
            &file,
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/home/user/proj\"}",
        )
        .unwrap();
        assert_eq!(
            transcript_cwd_bounded(&file),
            Some("/home/user/proj".to_string())
        );
        // First non-empty string cwd wins; empty-string cwd is skipped.
        let skip = home.path().join("skip.jsonl");
        std::fs::write(&skip, "{\"cwd\":\"\"}\n{\"cwd\":42}\n{\"cwd\":\"/real\"}\n").unwrap();
        assert_eq!(transcript_cwd_bounded(&skip), Some("/real".to_string()));
        // Missing file: swallowed to None (checked variant is deferred).
        assert_eq!(
            transcript_cwd_bounded(&home.path().join("absent.jsonl")),
            None
        );
    }

    // -- G28: ONE shared claude store-root rule (pure seam) ------------------
    //
    // `claude_home_candidates_from` takes the env lookup AND the platform home
    // as parameters, so these tests never mutate process-global env. The
    // platform home is `std::env::home_dir()` in production — USERPROFILE on
    // Windows, HOME-else-passwd on POSIX — exactly the real CLI's
    // `os.homedir()`; the raw HOME variable is never consulted here.

    fn env_of(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(&'static str, &'static str)> = pairs.to_vec();
        move |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        }
    }

    #[test]
    fn store_roots_use_the_platform_home_when_home_is_unset() {
        // POSIX passwd fallback shape: HOME unset, the platform home still
        // resolves (here injected as `/h`).
        assert_eq!(
            claude_home_candidates_from(env_of(&[]), Some(PathBuf::from("/h"))),
            vec![PathBuf::from("/h").join(".claude")]
        );
    }

    #[test]
    fn store_roots_follow_the_injected_platform_home_never_the_raw_home_var() {
        // Windows shape: the CLI resolves `~` through USERPROFILE and never
        // reads HOME. A stray HOME value must not add (or replace) a root.
        let profile = PathBuf::from(r"C:\Users\u");
        assert_eq!(
            claude_home_candidates_from(env_of(&[]), Some(profile.clone())),
            vec![profile.join(".claude")]
        );
        assert_eq!(
            claude_home_candidates_from(
                env_of(&[("HOME", "/never-consulted")]),
                Some(profile.clone())
            ),
            vec![profile.join(".claude")],
            "the raw HOME variable is not a store-root input"
        );
    }

    #[test]
    fn store_roots_are_ordered_config_dir_then_claude_home_then_platform_home_deduped() {
        assert_eq!(
            claude_home_candidates_from(
                env_of(&[("CLAUDE_CONFIG_DIR", "/cfg"), ("CLAUDE_HOME", "/ch")]),
                Some(PathBuf::from("/h")),
            ),
            vec![
                PathBuf::from("/cfg"),
                PathBuf::from("/ch"),
                PathBuf::from("/h").join(".claude"),
            ]
        );
        // A CLAUDE_CONFIG_DIR naming the default root is scanned ONCE.
        assert_eq!(
            claude_home_candidates_from(
                env_of(&[("CLAUDE_CONFIG_DIR", "/h/.claude"), ("CLAUDE_HOME", "/ch")]),
                Some(PathBuf::from("/h")),
            ),
            vec![PathBuf::from("/h/.claude"), PathBuf::from("/ch")]
        );
        // Empty values never produce a bogus relative root.
        assert_eq!(
            claude_home_candidates_from(
                env_of(&[("CLAUDE_CONFIG_DIR", ""), ("CLAUDE_HOME", "")]),
                Some(PathBuf::new()),
            ),
            Vec::<PathBuf>::new()
        );
        // Nothing resolvable at all: no roots (the "cannot check" state).
        assert_eq!(
            claude_home_candidates_from(env_of(&[]), None),
            Vec::<PathBuf>::new()
        );
    }

    // -- G28: three-state transcript locator --------------------------------
    //
    // Found / Absent / Unreadable: only a CLEAN miss everywhere is Absent
    // (the positive "session gone" evidence); an IO failure is Unreadable and
    // must never read as gone. Hermetic: explicit temp roots, no env.

    const LOCATE_ID: &str = "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd";

    /// Makes `dir` unreadable (mode 000) and restores it on drop so the
    /// TempDir cleanup works even if an assertion panics. `None` when the
    /// process bypasses permission bits (root / CAP_DAC_OVERRIDE): those
    /// runs cannot produce the EACCES under test, so the caller skips.
    #[cfg(unix)]
    pub(crate) struct UnreadableDir(PathBuf);
    #[cfg(unix)]
    impl UnreadableDir {
        pub(crate) fn make(dir: &Path) -> Option<Self> {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o000)).unwrap();
            let guard = Self(dir.to_path_buf());
            if std::fs::read_dir(dir).is_ok() {
                eprintln!("skipping: euid bypasses permission checks");
                return None;
            }
            Some(guard)
        }
    }
    #[cfg(unix)]
    impl Drop for UnreadableDir {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }

    fn plant(root: &Path, project: &str, id: &str) -> PathBuf {
        let dir = root.join("projects").join(project);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{id}.jsonl"));
        std::fs::write(&file, "{}\n").unwrap();
        file
    }

    fn io_kind(location: &TranscriptLocation) -> Option<std::io::ErrorKind> {
        match location {
            TranscriptLocation::Unreadable(LocateError::Io { kind, .. }) => Some(*kind),
            _ => None,
        }
    }

    #[test]
    fn locate_state_reads_a_missing_projects_dir_as_absent() {
        let home = temp_home(); // no projects/ at all
        assert_eq!(
            locate_transcript_state_in(&[home.path().to_path_buf()], LOCATE_ID),
            TranscriptLocation::Absent
        );
        // A store root that does not exist at all is also a clean miss.
        assert_eq!(
            locate_transcript_state_in(&[home.path().join("never-created")], LOCATE_ID),
            TranscriptLocation::Absent
        );
    }

    #[test]
    fn locate_state_with_no_store_root_is_unreadable_never_absent() {
        assert_eq!(
            locate_transcript_state_in(&[], LOCATE_ID),
            TranscriptLocation::Unreadable(LocateError::NoStoreRoot)
        );
    }

    #[test]
    fn locate_state_finds_the_direct_and_the_one_level_nested_layouts() {
        let home = temp_home();
        let direct = plant(home.path(), "-repo", LOCATE_ID);
        assert_eq!(
            locate_transcript_state_in(&[home.path().to_path_buf()], LOCATE_ID),
            TranscriptLocation::Found(direct)
        );
        let nested_id = "dcbadcba-dcba-4cba-8cba-dcbadcbadcba";
        let nested_dir = home.path().join("projects").join("-repo").join("sessions");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let nested = nested_dir.join(format!("{nested_id}.jsonl"));
        std::fs::write(&nested, "{}\n").unwrap();
        assert_eq!(
            locate_transcript_state_in(&[home.path().to_path_buf()], nested_id),
            TranscriptLocation::Found(nested)
        );
        // Traversal-shaped ids are a clean miss, never a probe outside the store.
        assert_eq!(
            locate_transcript_state_in(&[home.path().to_path_buf()], "../etc/passwd"),
            TranscriptLocation::Absent
        );
    }

    #[test]
    fn locate_state_ignores_a_regular_file_in_the_projects_dir() {
        let home = temp_home();
        let projects = home.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::write(projects.join("-not-a-dir"), "i am a file\n").unwrap();
        assert_eq!(
            locate_transcript_state_in(&[home.path().to_path_buf()], LOCATE_ID),
            TranscriptLocation::Absent
        );
    }

    /// An id the OS rejects as a file name (too long for one path component,
    /// or carrying a NUL) cannot name a transcript, so a store that holds
    /// project dirs answers a clean Absent -- never Unreadable, which would
    /// blame the store for what is wrong with the id.
    #[test]
    fn locate_state_reads_an_id_no_file_can_be_named_as_absent() {
        let home = temp_home();
        // Real project dirs, both layouts: every candidate probe runs.
        plant(home.path(), "-repo", LOCATE_ID);
        std::fs::create_dir_all(home.path().join("projects").join("-repo").join("nested")).unwrap();
        let too_long = "a".repeat(300);
        for id in [too_long.as_str(), "abcd\0efgh"] {
            assert_eq!(
                locate_transcript_state_in(&[home.path().to_path_buf()], id),
                TranscriptLocation::Absent,
                "id {:?}... names no possible file",
                &id[..id.len().min(12)]
            );
        }
    }

    /// The one error sink every scan branch reports to (listing a dir, reading
    /// one listed entry, probing a candidate): expected absence -- including an
    /// entry deleted between the listing and its type check -- is never an
    /// error, and the FIRST real error is the one kept.
    #[test]
    fn scan_errors_ignore_expected_absence_and_keep_the_first_real_error() {
        use std::io::{Error, ErrorKind};
        let mut errors = ScanErrors::default();
        errors.remember(Error::from(ErrorKind::NotFound));
        errors.remember(Error::from(ErrorKind::NotADirectory));
        assert!(errors.first().is_none(), "expected absence is a clean miss");
        errors.remember(Error::from(ErrorKind::PermissionDenied));
        errors.remember(Error::from(ErrorKind::NotFound));
        errors.remember(Error::from(ErrorKind::Other));
        assert_eq!(
            errors.first().map(Error::kind),
            Some(ErrorKind::PermissionDenied)
        );
    }

    /// One listed entry failing must not hide the others: an entry that
    /// vanished before its type check (`NotFound`) is a clean miss, an entry
    /// that could not be read is remembered, and every readable directory
    /// after either is still returned for the scan to probe.
    #[test]
    fn subdir_listing_keeps_going_past_a_bad_entry_and_skips_a_vanished_one() {
        use std::io::{Error, ErrorKind};
        let mut errors = ScanErrors::default();
        let dirs = collect_subdirs(
            [
                Ok((true, PathBuf::from("projects/-b"))),
                Err(Error::from(ErrorKind::NotFound)),
                Ok((false, PathBuf::from("projects/stray.txt"))),
                Err(Error::from(ErrorKind::PermissionDenied)),
                Ok((true, PathBuf::from("projects/-a"))),
            ],
            &mut errors,
        );
        assert_eq!(
            dirs,
            [PathBuf::from("projects/-a"), PathBuf::from("projects/-b")],
            "every readable directory survives a bad entry, sorted"
        );
        assert_eq!(
            errors.first().map(Error::kind),
            Some(ErrorKind::PermissionDenied),
            "the vanished entry is not an error; the unreadable one is"
        );

        let mut errors = ScanErrors::default();
        collect_subdirs(
            [
                Ok((true, PathBuf::from("projects/-a"))),
                Err(Error::from(ErrorKind::NotFound)),
            ],
            &mut errors,
        );
        assert!(
            errors.first().is_none(),
            "a listing whose only failure is a vanished entry is clean"
        );
    }

    #[cfg(unix)]
    #[test]
    fn locate_state_reports_an_unreadable_projects_dir_as_unreadable() {
        let home = temp_home();
        let projects = home.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let Some(_locked) = UnreadableDir::make(&projects) else {
            return;
        };
        let location = locate_transcript_state_in(&[home.path().to_path_buf()], LOCATE_ID);
        assert_eq!(
            io_kind(&location),
            Some(std::io::ErrorKind::PermissionDenied),
            "an EACCES store is unreadable, never absent: {location:?}"
        );
        match location {
            TranscriptLocation::Unreadable(LocateError::Io { root, .. }) => {
                assert_eq!(root, home.path(), "the error names the failing store root");
            }
            other => panic!("expected Unreadable(Io), got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn locate_state_finds_a_hit_under_a_later_root_despite_an_unreadable_earlier_root() {
        let bad = temp_home();
        let good = temp_home();
        let bad_projects = bad.path().join("projects");
        std::fs::create_dir_all(&bad_projects).unwrap();
        let file = plant(good.path(), "-repo", LOCATE_ID);
        let Some(_locked) = UnreadableDir::make(&bad_projects) else {
            return;
        };
        assert_eq!(
            locate_transcript_state_in(
                &[bad.path().to_path_buf(), good.path().to_path_buf()],
                LOCATE_ID
            ),
            TranscriptLocation::Found(file)
        );
    }

    #[cfg(unix)]
    #[test]
    fn locate_state_with_one_unreadable_root_and_one_clean_miss_is_unreadable() {
        let bad = temp_home();
        let clean = temp_home();
        let bad_projects = bad.path().join("projects");
        std::fs::create_dir_all(&bad_projects).unwrap();
        std::fs::create_dir_all(clean.path().join("projects").join("-other")).unwrap();
        let Some(_locked) = UnreadableDir::make(&bad_projects) else {
            return;
        };
        for roots in [
            vec![bad.path().to_path_buf(), clean.path().to_path_buf()],
            vec![clean.path().to_path_buf(), bad.path().to_path_buf()],
        ] {
            let location = locate_transcript_state_in(&roots, LOCATE_ID);
            assert_eq!(
                io_kind(&location),
                Some(std::io::ErrorKind::PermissionDenied),
                "a miss that could not check every root is not proof of absence: {location:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn locate_state_keeps_scanning_past_an_unreadable_project_dir() {
        let home = temp_home();
        let locked_project = home.path().join("projects").join("-a-locked");
        std::fs::create_dir_all(&locked_project).unwrap();
        let Some(_locked) = UnreadableDir::make(&locked_project) else {
            return;
        };
        // No hit anywhere else: the locked project dir could hold the nested
        // transcript, so the answer is Unreadable.
        let location = locate_transcript_state_in(&[home.path().to_path_buf()], LOCATE_ID);
        assert_eq!(
            io_kind(&location),
            Some(std::io::ErrorKind::PermissionDenied),
            "{location:?}"
        );
        // A hit in a LATER project dir still wins over the remembered error.
        let file = plant(home.path(), "-b-open", LOCATE_ID);
        assert_eq!(
            locate_transcript_state_in(&[home.path().to_path_buf()], LOCATE_ID),
            TranscriptLocation::Found(file)
        );
    }

    // -- Task 6 (resolve parity): checked locator + checked cwd reader ------
    //
    // HERMETIC BY CONSTRUCTION: every test below builds a temp projects dir
    // and passes it via the `projects_roots` parameter; NO test mutates
    // process-global env (CLAUDE_HOME/CLAUDE_CONFIG_DIR/HOME), so there is
    // nothing to race against the crate's env-mutating claude tests.

    #[test]
    fn locate_transcript_checked_misses_on_an_absent_projects_dir() {
        let home = temp_home();
        let roots = vec![home.path().join("projects")]; // never created
        assert_eq!(
            locate_transcript_checked(&roots, "11111111-1111-4111-8111-111111111111").unwrap(),
            None
        );
    }

    #[test]
    fn locate_transcript_checked_finds_the_subagent_child_layout() {
        // Node layout pass 2 (`claude-transcript-locator.ts:39-48`):
        // <projects>/<project-dir>/<parent-session>/subagents/<id>.jsonl.
        let home = temp_home();
        let projects = home.path().join("projects");
        let sub = projects
            .join("-repo-alpha")
            .join("99999999-9999-4999-8999-999999999999")
            .join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            locate_transcript_checked(&[projects], "22222222-2222-4222-8222-222222222222").unwrap(),
            Some(file)
        );
    }

    #[test]
    fn locate_transcript_checked_treats_a_file_project_entry_as_a_miss_enotdir_parity() {
        // Node reports ENOTDIR as a normal miss (`claude-transcript-locator
        // .ts:33-37`): a candidate path whose component is a REGULAR FILE
        // (descending into it fails NotADirectory) yields Ok(None), not Err.
        let home = temp_home();
        let projects = home.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::write(projects.join("-not-a-dir"), "i am a file\n").unwrap();
        assert_eq!(
            locate_transcript_checked(&[projects], "33333333-3333-4333-8333-333333333333").unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn locate_transcript_checked_propagates_permission_denied() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home();
        let projects = home.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root / CAP_DAC_OVERRIDE bypasses mode bits — probe first.
        if std::fs::read_dir(&projects).is_ok() {
            std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipping: euid bypasses permission checks");
            return;
        }
        let err = locate_transcript_checked(
            std::slice::from_ref(&projects),
            "44444444-4444-4444-8444-444444444444",
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        // Restore so TempDir cleanup works.
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn locate_transcript_checked_probes_direct_across_all_roots_before_any_subagent() {
        // Node's GLOBAL two-pass order (`claude-transcript-locator.ts:69-88`):
        // with roots [A, B], a DIRECT hit in B outranks a SUBAGENT hit in A —
        // NOT per-root direct+subagent.
        let home = temp_home();
        let root_a = home.path().join("a-projects");
        let root_b = home.path().join("b-projects");
        let id = "55555555-5555-4555-8555-555555555555";
        let sub = root_a
            .join("-repo")
            .join("88888888-8888-4888-8888-888888888888")
            .join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(format!("{id}.jsonl")), "{}\n").unwrap();
        let direct_dir = root_b.join("-repo");
        std::fs::create_dir_all(&direct_dir).unwrap();
        let direct = direct_dir.join(format!("{id}.jsonl"));
        std::fs::write(&direct, "{}\n").unwrap();
        assert_eq!(
            locate_transcript_checked(&[root_a, root_b], id).unwrap(),
            Some(direct)
        );
    }

    #[test]
    fn transcript_cwd_checked_is_bounded_to_the_64kib_prefix() {
        // Node parity (`CWD_SCAN_BYTES`, `claude-transcript-locator.ts:30-31,
        // 131-135`): a cwd line starting beyond the first 64 KiB is invisible.
        let home = temp_home();
        let file = home.path().join("big.jsonl");
        let filler_line = "{\"type\":\"noise\"}\n";
        let mut content = String::new();
        while content.len() <= 64 * 1024 {
            content.push_str(filler_line);
        }
        content.push_str("{\"type\":\"user\",\"cwd\":\"/beyond/prefix\"}\n");
        std::fs::write(&file, &content).unwrap();
        assert_eq!(transcript_cwd_checked(&file).unwrap(), None);
        // A COMPLETE final line with no trailing newline still parses — Node's
        // `head.split('\n')` loop has no discard-the-tail rule.
        let small = home.path().join("small.jsonl");
        std::fs::write(
            &small,
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/home/user/proj\"}",
        )
        .unwrap();
        assert_eq!(
            transcript_cwd_checked(&small).unwrap(),
            Some("/home/user/proj".to_string())
        );
    }

    #[test]
    fn transcript_cwd_checked_treats_a_raced_deletion_as_a_cwdless_hit() {
        // Expected-absence open error ⇒ Ok(None): the locate hit survives,
        // cwd-less — Node behaves the same (`claude-transcript-locator.ts:
        // 121-129`).
        let home = temp_home();
        assert_eq!(
            transcript_cwd_checked(&home.path().join("absent.jsonl")).unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn transcript_cwd_checked_propagates_a_permission_denied_open() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home();
        let file = home.path().join("locked.jsonl");
        std::fs::write(&file, "{\"cwd\":\"/x\"}\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&file).is_ok() {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            eprintln!("skipping: euid bypasses permission checks");
            return;
        }
        let err = transcript_cwd_checked(&file).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    const SAMPLE_TRANSCRIPT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/claude-transcript-sample.jsonl"
    ));
    const GOLDEN_SNAPSHOT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/claude-snapshot-golden.json"
    ));

    #[test]
    fn builder_output_matches_the_golden_snapshot_fixture() {
        let built = build_claude_snapshot_json(
            "freshclaude",
            "44444444-4444-4444-8444-444444444444",
            SAMPLE_TRANSCRIPT,
            1753437600000,
            None,
        );
        let golden: serde_json::Value =
            serde_json::from_str(GOLDEN_SNAPSHOT).expect("golden parses");
        assert_eq!(built, golden);
    }

    #[test]
    fn claude_turns_tag_every_summary_echo() {
        let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0, None);
        let turns = built["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 6);
        for turn in turns {
            assert_eq!(
                turn["summaryKind"],
                json!("echo"),
                "turn {:?}",
                turn["turnId"]
            );
        }
    }

    #[test]
    fn summarize_unifies_truncation_and_tool_result_labels() {
        let long_text = "x".repeat(200);
        let items = vec![json!({ "kind": "text", "text": long_text })];
        assert_eq!(summarize(&items).chars().count(), 140);

        let ok = vec![json!({ "kind": "tool_result", "content": "out", "isError": false })];
        assert_eq!(summarize(&ok), "Tool result");
        let err = vec![json!({ "kind": "tool_result", "content": "boom", "isError": true })];
        assert_eq!(summarize(&err), "Tool error");

        // Tool names count as summaries: a >140-char tool_use name truncates
        // through the same shared policy (fresh-eyes round 1, Finding 2 — this is
        // the arm a `return name.to_string()` would bypass).
        let long_name = "mcp__server__".to_string() + &"n".repeat(200);
        let tools = vec![json!({ "kind": "tool_use", "name": long_name.clone() })];
        let expected: String = long_name.chars().take(140).collect();
        assert_eq!(summarize(&tools), expected);
    }

    #[test]
    fn claude_zero_item_messages_are_dropped_before_summarizing() {
        // Preservation pin (passes immediately — it guards an EXISTING invariant,
        // see Step 2): `summarize`'s final fallback is the non-blank literal
        // "[claude turn]", so the `if items.is_empty() { continue; }` guard ahead
        // of it is the only thing keeping zero-item non-blank-summary turns
        // unreachable (load-bearing validation LB-4). A message whose blocks are
        // all unrecognized yields no items and must emit NO turn at all.
        let transcript: &str = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"future_block","data":"x"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"msg_ok","content":[{"type":"text","text":"real answer"}]}}"#,
            "\n",
        );
        let built = build_claude_snapshot_json("freshclaude", "t", transcript, 0, None);
        let turns = built["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["summary"], json!("real answer"));
        assert!(turns
            .iter()
            .all(|turn| !turn["items"].as_array().unwrap().is_empty()));
    }

    /// Task 3 (presence-of-pending gate, `normalize.ts:226-232`): an EMPTY overlay must
    /// leave the disk-built snapshot untouched — the reload-while-idle read keeps the
    /// exact golden shape (the route's byte-identical guarantee, pinned at unit level).
    #[test]
    fn pending_overlay_with_empty_sets_leaves_the_snapshot_unchanged() {
        let built = build_claude_snapshot_json(
            "freshclaude",
            "44444444-4444-4444-8444-444444444444",
            SAMPLE_TRANSCRIPT,
            1753437600000,
            None,
        );
        let mut overlaid = built.clone();
        apply_pending_overlay(&mut overlaid, Vec::new(), Vec::new());
        assert_eq!(overlaid, built, "an empty overlay is a strict no-op");
    }

    /// Task 3: a non-empty overlay populates `pendingApprovals`/`pendingQuestions` and
    /// flips the presence-of-pending gates; untouched capabilities/fields stay put.
    #[test]
    fn pending_overlay_populates_entries_and_flips_the_presence_gates() {
        let mut built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 7, None);
        let approvals = vec![json!({
            "requestId": "req-1", "toolName": "Bash", "toolUseID": "toolu_1",
            "input": { "command": "ls" },
        })];
        let questions = vec![json!({
            "requestId": "q-1", "questions": [{ "question": "Continue?" }],
        })];
        apply_pending_overlay(&mut built, approvals.clone(), questions.clone());
        assert_eq!(built["pendingApprovals"], json!(approvals));
        assert_eq!(built["pendingQuestions"], json!(questions));
        assert_eq!(built["capabilities"]["approvals"], json!(true));
        assert_eq!(built["capabilities"]["questions"], json!(true));
        // Untouched gates and fields.
        assert_eq!(built["capabilities"]["send"], json!(true));
        assert_eq!(built["capabilities"]["interrupt"], json!(true));
        assert_eq!(built["capabilities"]["fork"], json!(true));
        assert_eq!(built["sessionType"], json!("freshclaude"));
        assert_eq!(built["revision"], json!(7));
    }

    /// Task 3: the two gates track their own pending kind independently — approvals
    /// pending with NO questions leaves `capabilities.questions` false.
    #[test]
    fn pending_overlay_gates_track_each_pending_kind_independently() {
        let mut built = build_claude_snapshot_json("kilroy", "t", SAMPLE_TRANSCRIPT, 0, None);
        apply_pending_overlay(&mut built, vec![json!({ "requestId": "r-2" })], Vec::new());
        assert_eq!(built["pendingApprovals"], json!([{ "requestId": "r-2" }]));
        assert!(built["pendingQuestions"].as_array().unwrap().is_empty());
        assert_eq!(built["capabilities"]["approvals"], json!(true));
        assert_eq!(built["capabilities"]["questions"], json!(false));
    }

    #[test]
    fn user_turns_carry_role_user_and_literal_prompt_text() {
        // Load-bearing for the frozen client's local-echo clearing: claude's
        // send.accepted has no submittedTurnId, so the client matches prompt text
        // against role:'user' turns (freshAgentSlice fold).
        let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0, None);
        let turns = built["turns"].as_array().unwrap();
        let first = &turns[0];
        assert_eq!(first["role"], "user");
        assert_eq!(first["items"][0]["kind"], "text");
        assert_eq!(first["items"][0]["text"], "first question");
    }

    #[test]
    fn turn_ids_are_unique_and_ordering_is_transcript_order() {
        let built = build_claude_snapshot_json("kilroy", "t", SAMPLE_TRANSCRIPT, 0, None);
        assert_eq!(built["sessionType"], "kilroy");
        let turns = built["turns"].as_array().unwrap();
        let mut ids: Vec<&str> = turns
            .iter()
            .map(|t| t["turnId"].as_str().unwrap())
            .collect();
        let before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(
            ids.len(),
            before,
            "turnIds must be unique (historyBodies map key)"
        );
        assert_eq!(turns.len(), 6); // summary + malformed + isMeta lines skipped
        assert_eq!(built["latestTurnId"], turns[5]["turnId"]);
        // The dominant real prompt shape (object-with-string-content, ledger A5)
        // must yield a text turn -- local-echo clearing depends on it.
        assert_eq!(turns[3]["items"][0]["text"], "cli string content question");
    }

    /// Saves the named env vars on construction and restores them on drop (so the
    /// restore also runs on panic while the caller still holds `CLAUDE_ENV_LOCK` --
    /// locals drop in reverse declaration order, lock guard last).
    struct EnvVarsRestore {
        saved: Vec<(&'static str, Option<String>)>,
    }
    impl EnvVarsRestore {
        fn remove_all(keys: &[&'static str]) -> Self {
            let saved = keys
                .iter()
                .map(|k| {
                    let v = std::env::var(k).ok();
                    std::env::remove_var(k);
                    (*k, v)
                })
                .collect();
            Self { saved }
        }
    }
    impl Drop for EnvVarsRestore {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    #[tokio::test]
    async fn snapshot_with_no_resolvable_store_root_is_io_not_notfound() {
        // Cannot check => must not deny: with no store root at all the server
        // cannot assert the session is gone, so the error must be Io (-> 500),
        // never NotFound (-> 404 FRESH_AGENT_LOST_SESSION). Driven through the
        // roots seam: on POSIX the platform home can no longer be emptied via
        // env (passwd-entry fallback), so "no roots" is an injected input.
        let result = get_claude_snapshot_in(
            &[],
            "freshclaude",
            "55555555-5555-4555-8555-555555555555",
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(ClaudeSnapshotError::Io(_))),
            "expected Io (cannot-check must not deny), got {result:?}"
        );
    }

    /// G28: an unreadable store (EACCES on `projects/`) cannot prove the
    /// session gone, so the snapshot is Io (-> 500), never NotFound (-> 404
    /// FRESH_AGENT_LOST_SESSION, which the client folds into "session lost").
    #[cfg(unix)]
    #[tokio::test]
    async fn snapshot_with_an_unreadable_store_is_io_not_notfound() {
        let home = temp_home();
        let projects = home.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let Some(_locked) = UnreadableDir::make(&projects) else {
            return;
        };
        let result = get_claude_snapshot_in(
            &[home.path().to_path_buf()],
            "freshclaude",
            "55555555-5555-4555-8555-555555555555",
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(ClaudeSnapshotError::Io(_))),
            "expected Io (cannot-check must not deny), got {result:?}"
        );
    }

    /// Unified agent names (Task 2 review, M3): `locate_transcript_selected`
    /// — the verified-evidence source for every claude bind (tick, signal
    /// lane, fresh init) — answers the SELECTED config root, the transcript
    /// path, and the transcript's ORIGINAL cwd for a transcript planted
    /// under the `CLAUDE_CONFIG_DIR` candidate, and agrees with
    /// [`locate_transcript`] on the same ordered candidates (one definition
    /// of "the transcript exists"). Env vars are process-global — serialize
    /// under the shared claude env lock. Only the claude-specific roots are
    /// cleared: `HOME` is never touched, because tests that do not take the
    /// claude lock read it concurrently (the OpenCode home harness asserts
    /// the parent's `HOME` is unchanged) and the platform home candidate
    /// resolves through the passwd entry without it anyway.
    #[tokio::test]
    async fn locate_transcript_selected_answers_root_path_and_cwd_under_config_dir() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let _restore = EnvVarsRestore::remove_all(&["CLAUDE_CONFIG_DIR", "CLAUDE_HOME"]);
        let store = temp_home();
        std::env::set_var("CLAUDE_CONFIG_DIR", store.path());
        let id = "66666666-6666-4666-8666-666666666666";
        let dir = store.path().join("projects").join("-selected-proj");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{id}.jsonl"));
        std::fs::write(
            &file,
            "{\"type\":\"user\",\"cwd\":\"/orig/cwd\",\"message\":\"hi\"}\n",
        )
        .unwrap();

        let selected = locate_transcript_selected(id).expect("the planted transcript locates");
        // The SELECTED root is the candidate that matched — never an ambient
        // default — and the routing evidence answers with it.
        assert_eq!(
            selected.config_root,
            store.path(),
            "the selected config root must be the CLAUDE_CONFIG_DIR candidate"
        );
        assert_eq!(selected.transcript_path, file);
        assert_eq!(
            selected.transcript_cwd.as_deref(),
            Some("/orig/cwd"),
            "the transcript's original cwd is the routing input"
        );
        // Ordering parity: the same ordered candidates, so the same file.
        assert_eq!(locate_transcript(id), Some(file));
        // A miss everywhere answers None for BOTH locators.
        let absent = "77777777-7777-4777-8777-777777777777";
        assert!(locate_transcript_selected(absent).is_none());
        assert!(locate_transcript(absent).is_none());
    }

    // ── kata 1wxv Task 4: resume-point math + real-uuid turn ids ────────────

    fn uuid_transcript() -> String {
        // user/assistant alternation, uuid + parentUuid chained:
        [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"prompt two"}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"t4","message":{"role":"assistant","content":[{"type":"text","text":"answer two"}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")
    }

    /// A transcript WITH non-display chain carriers interleaved (a tool_result
    /// carrier and a sidechain/meta line both stay visible to the raw parentUuid
    /// chain but the display parser filters them out) — the display-predecessor
    /// rule is VOID per correction item 3 (chain position is raw, always).
    fn uuid_transcript_with_carriers() -> String {
        [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"c1","isSidechain":true,"parentUuid":"u1","timestamp":"t1b","message":{"role":"assistant","content":[{"type":"text","text":"sidechain noise"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"c1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"bash","input":{"command":"ls"}}]}}),
            json!({"type":"user","uuid":"tr1","parentUuid":"a1","timestamp":"t2b","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"files"}],"is_error":false}]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"tr1","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"prompt two"}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"t4","message":{"role":"assistant","content":[{"type":"text","text":"answer two"}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn turns_carry_real_message_uuids_when_present() {
        let turns = parse_transcript_turns("thread-x", &uuid_transcript());
        let ids: Vec<&str> = turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert!(
            ids.contains(&"u1")
                && ids.contains(&"a1")
                && ids.contains(&"u2")
                && ids.contains(&"a2"),
            "turn ids are the transcript uuids, not synthetic thread:ordinal ids: {ids:?}"
        );
    }

    /// Synthetic `{thread}:{ordinal}` ids remain the fallback for uuid-less lines
    /// (the pre-existing fixture corpus), so the turn-id change is additive.
    #[test]
    fn turns_fall_back_to_synthetic_ids_without_uuids() {
        let turns = parse_transcript_turns("thread-x", SAMPLE_TRANSCRIPT);
        let ids: Vec<&str> = turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert!(
            ids.iter().all(|id| id.starts_with("thread-x:")),
            "uuid-less lines keep the synthetic id shape: {ids:?}"
        );
    }

    #[test]
    fn resolve_resume_point_step_targets_the_last_user_step() {
        let point = resolve_resume_point(&uuid_transcript(), "thread-x", ResumeTarget::Step)
            .expect("resolves");
        assert_eq!(
            point.resume_at_uuid.as_deref(),
            Some("a1"),
            "keep everything before prompt two's group"
        );
        assert_eq!(point.prompt_text, "prompt two");
        let removed_ids: Vec<&str> = point
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(removed_ids, vec!["u2", "a2"]);
    }

    #[test]
    fn resolve_resume_point_at_the_first_message_resolves_before_the_first_message() {
        // r2: RESOLVABLE and legal — resume_at_uuid None means "before the first message";
        // the whole transcript becomes the removed slice and the handler takes the
        // fresh-conversation leg (no refusal exists).
        let point = resolve_resume_point(
            &uuid_transcript(),
            "thread-x",
            ResumeTarget::ToTurn("u1".into()),
        )
        .expect("resolves");
        assert_eq!(point.resume_at_uuid, None, "before the first message");
        assert_eq!(point.prompt_text, "prompt one");
        let removed_ids: Vec<&str> = point
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            removed_ids,
            vec!["u1", "a1", "u2", "a2"],
            "the entire transcript is the removed slice"
        );
    }

    #[test]
    fn resolve_resume_point_step_on_a_single_step_resolves_before_the_first_message() {
        let one_step = uuid_transcript()
            .lines()
            .take(2)
            .collect::<Vec<_>>()
            .join("\n"); // u1/a1 only
        let point =
            resolve_resume_point(&one_step, "thread-x", ResumeTarget::Step).expect("resolves");
        assert_eq!(
            point.resume_at_uuid, None,
            "step on a one-turn history empties the conversation — legal per r2"
        );
        assert_eq!(point.prompt_text, "prompt one");
    }

    #[test]
    fn resolve_resume_point_to_turn_middle_keeps_prefix() {
        let point = resolve_resume_point(
            &uuid_transcript(),
            "thread-x",
            ResumeTarget::ToTurn("u2".into()),
        )
        .expect("resolves");
        assert_eq!(point.resume_at_uuid.as_deref(), Some("a1"));
        assert_eq!(point.removed_turns.len(), 2);
    }

    /// Steps split on USER-ANCHOR lines only: a tool_result carrier must NOT
    /// start a step, and a sidechain line keeps chain position while never
    /// surfacing in the removed-turns projection (raw-chain rule everywhere).
    #[test]
    fn resolve_resume_point_walks_the_raw_chain_through_non_display_carriers() {
        let point = resolve_resume_point(
            &uuid_transcript_with_carriers(),
            "thread-x",
            ResumeTarget::Step,
        )
        .expect("resolves");
        assert_eq!(
            point.resume_at_uuid.as_deref(),
            Some("tr1"),
            "the keep point is the raw parent of u2 — the tool_result carrier, \
             which resumeSessionAt accepts (any chain uuid), even though the display list hides it"
        );
        let removed_ids: Vec<&str> = point
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            removed_ids,
            vec!["u2", "a2"],
            "only the display projection of the removed slice (no carriers/leaked sidechain noise)"
        );
        // toTurn(u2) maps identically; an addressed assistant uuid maps to its
        // owning user step (the first user anchor at-or-before it).
        let to_anchor = resolve_resume_point(
            &uuid_transcript_with_carriers(),
            "thread-x",
            ResumeTarget::ToTurn("a2".into()),
        )
        .expect("assistant target resolves to its owning user step");
        assert_eq!(to_anchor.resume_at_uuid.as_deref(), Some("tr1"));
        assert_eq!(to_anchor.prompt_text, "prompt two");
    }

    /// The guard declares the one prompted turn a fork discards (the SDK's
    /// `resumeDropsTurn`), and nothing when the fork discards nothing or
    /// more than one turn, or when it boots fresh.
    #[test]
    fn the_drops_turn_guard_declares_the_one_prompted_turn_a_fork_discards() {
        let transcript = uuid_transcript_with_carriers();
        assert_eq!(
            drops_turn_guard(&transcript, Some("tr1")).as_deref(),
            Some("u2")
        );
        assert_eq!(
            drops_turn_guard(&transcript, Some("a1")),
            None,
            "the discarded part starts with the kept turn's tool result"
        );
        assert_eq!(
            drops_turn_guard(&transcript, Some("c1")),
            None,
            "the discarded part starts mid-turn"
        );
        assert_eq!(
            drops_turn_guard(&transcript, Some("a2")),
            None,
            "nothing is discarded"
        );
        assert_eq!(
            drops_turn_guard(&transcript, None),
            None,
            "a fresh boot forks nothing"
        );
        assert_eq!(
            drops_turn_guard(&transcript, Some("gone")),
            None,
            "an unknown keep point"
        );
        let three_turns = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"one"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"1"}]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a1","message":{"role":"user","content":"two"}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"role":"assistant","content":[{"type":"text","text":"2"}]}}),
            json!({"type":"user","uuid":"u3","parentUuid":"a2","message":{"role":"user","content":"three"}}),
            json!({"type":"assistant","uuid":"a3","parentUuid":"u3","message":{"role":"assistant","content":[{"type":"text","text":"3"}]}}),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        assert_eq!(
            drops_turn_guard(&three_turns, Some("a2")).as_deref(),
            Some("u3")
        );
        assert_eq!(
            drops_turn_guard(&three_turns, Some("a1")),
            None,
            "two prompted turns: one guard declares one turn"
        );
    }

    /// A fork keeps through the last chain entry of the step holding the turn it
    /// was asked to fork at: a prompt, an answer, or a line inside the step (a
    /// tool-result carrier) all keep the whole step.
    #[test]
    fn a_fork_at_a_turn_keeps_through_the_end_of_that_turns_step() {
        let transcript = uuid_transcript_with_carriers();
        for at in ["u1", "c1", "a1", "tr1"] {
            assert_eq!(
                fork_point(&transcript, Some(at)).as_deref(),
                Ok("tr1"),
                "fork at {at}"
            );
        }
        assert_eq!(fork_point(&transcript, Some("u2")).as_deref(), Ok("a2"));
        assert_eq!(fork_point(&transcript, Some("a2")).as_deref(), Ok("a2"));
    }

    /// With no turn named, a fork keeps the whole conversation (its chain tip).
    #[test]
    fn a_fork_with_no_turn_keeps_through_the_tip() {
        assert_eq!(
            fork_point(&uuid_transcript_with_carriers(), None).as_deref(),
            Ok("a2")
        );
    }

    /// The client's split-row ids (`<turn>:row-<n>`) name their turn.
    #[test]
    fn a_fork_at_a_split_row_id_forks_at_its_turn() {
        assert_eq!(
            fork_point(&uuid_transcript_with_carriers(), Some("u1:row-1")).as_deref(),
            Ok("tr1")
        );
    }

    #[test]
    fn a_fork_at_a_turn_the_conversation_does_not_hold_is_refused() {
        assert_eq!(
            fork_point(&uuid_transcript(), Some("gone")),
            Err(ForkPointError::TurnNotFound)
        );
    }

    #[test]
    fn an_empty_conversation_has_nothing_to_fork() {
        assert_eq!(fork_point("", None), Err(ForkPointError::Empty));
        assert_eq!(fork_point("", Some("u1")), Err(ForkPointError::Empty));
    }

    #[test]
    fn resolve_resume_point_unknown_target_is_not_found() {
        assert!(resolve_resume_point(
            &uuid_transcript(),
            "thread-x",
            ResumeTarget::ToTurn("nope".into())
        )
        .is_err());
    }

    #[test]
    fn resolve_resume_point_empty_transcript_is_empty() {
        assert!(matches!(
            resolve_resume_point("", "thread-x", ResumeTarget::Step),
            Err(ResumeResolveError::Empty)
        ));
    }

    #[test]
    fn raw_chain_tip_is_the_last_uuid_of_the_parent_chain() {
        assert_eq!(raw_chain_tip(&uuid_transcript()).as_deref(), Some("a2"));
        assert_eq!(
            raw_chain_tip(&uuid_transcript_with_carriers()).as_deref(),
            Some("a2")
        );
        assert_eq!(raw_chain_tip(""), None, "no chain lines => no tip");
    }

    #[test]
    fn raw_lcp_end_matches_on_uuid_and_message_only() {
        // The current session's fork retains the original's prefix uuids/messages
        // but rewrites sessionId/gitBranch/timestamps — those fields are NEVER
        // compared.
        let current = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"sessionId":"new","gitBranch":"z","timestamp":"T1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"new","timestamp":"T2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n");
        assert_eq!(
            raw_lcp_end(&current, &uuid_transcript()).as_deref(),
            Some("a1")
        );
        // A message divergence truncates the LCP at the first differing entry.
        let edited = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"REWRITTEN"}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n");
        assert_eq!(
            raw_lcp_end(&edited, &uuid_transcript()).as_deref(),
            Some("u1")
        );
        // An empty current has a vacuous common prefix (the whole-empty-prefix rule
        // the first-turn-undo redo leg depends on).
        assert_eq!(
            raw_lcp_end("", &uuid_transcript()),
            None,
            "no matched entries => None (vacuous)"
        );
    }

    // ── redo_resume_target / restored_slice_turns (r3 boundary rule: every
    // resume point is THE LAST UUID OF THE TARGET STEP'S RAW-CHAIN GROUP — its
    // assistant tail — never the next turn's first uuid) ─────────────────────

    fn two_step_original() -> String {
        uuid_transcript()
    }

    fn prefix_after_undo() -> String {
        // The post-undo current session: the u1/a1 prefix only (fork at a1).
        uuid_transcript()
            .lines()
            .take(2)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn step_op() -> crate::rollback_record::RollbackRequest {
        use crate::rollback_record::*;
        RollbackRequest {
            direction: RollbackDirection::Redo,
            mode: RollbackModeReq::Step,
            turn_id: None,
            session_id: "s".into(),
            session_type: freshell_protocol::SessionType::Freshclaude,
            provider: freshell_protocol::AgentProvider::Claude,
            request_id: "r".into(),
            cwd: None,
            observed_epoch: None,
            observed_generation: None,
        }
    }

    #[test]
    fn redo_resume_target_step_from_a_prefix_grows_one_step_to_its_group_end() {
        let op = step_op();
        let uuid = redo_resume_target(&two_step_original(), &prefix_after_undo(), &op)
            .expect("resolves")
            .expect("a step exists beyond the prefix");
        assert_eq!(uuid, "a2", "redo restores through the restored step's OWN last uuid (r3) — not the next turn's first");
    }

    #[test]
    fn redo_resume_target_to_turn_resumes_at_the_addressed_groups_last_uuid() {
        let mut op = step_op();
        op.mode = crate::rollback_record::RollbackModeReq::ToTurn;
        op.turn_id = Some("u2".into());
        let uuid = redo_resume_target(&two_step_original(), &prefix_after_undo(), &op)
            .expect("resolves")
            .expect("target exists");
        assert_eq!(
            uuid, "a2",
            "toTurn(u2) keeps through a2 (the u2/a2 group end)"
        );
    }

    #[test]
    fn redo_resume_target_to_turn_on_an_unknown_uuid_errors() {
        let mut op = step_op();
        op.mode = crate::rollback_record::RollbackModeReq::ToTurn;
        op.turn_id = Some("nope".into());
        assert!(redo_resume_target(&two_step_original(), &prefix_after_undo(), &op).is_err());
    }

    #[test]
    fn redo_resume_target_with_prefix_equal_to_original_has_nothing_to_restore() {
        let op = step_op();
        assert_eq!(
            redo_resume_target(&two_step_original(), &two_step_original(), &op).expect("resolves"),
            None,
            "prefix == original => nothing to redo"
        );
    }

    #[test]
    fn redo_resume_target_on_an_empty_current_resumes_at_the_first_groups_end() {
        // r2 first-turn case: the fresh conversation's chain is EMPTY; redo
        // restores through the uuid ending the ORIGINAL's first step group —
        // its assistant tail (a1 for u1/a1), NEVER the first user-anchor uuid
        // u1 itself (that would restore only the bare prompt and make
        // undo/redo non-invertible).
        let op = step_op();
        let uuid = redo_resume_target(&two_step_original(), "", &op)
            .expect("resolves")
            .expect("a step exists");
        assert_eq!(uuid, "a1");
    }

    #[test]
    fn restored_slice_turns_projects_only_the_restored_range() {
        let slice = restored_slice_turns(&two_step_original(), &prefix_after_undo(), "a2");
        let ids: Vec<&str> = slice
            .turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["u2", "a2"]);
        assert_eq!(slice.prompt_text, "prompt two");
        // From an empty current (first-turn redo): the whole first group.
        let slice = restored_slice_turns(&two_step_original(), "", "a1");
        let ids: Vec<&str> = slice
            .turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["u1", "a1"]);
        assert_eq!(slice.prompt_text, "prompt one");
    }

    // ── kata 1wxv Task 5: snapshot rollback surfacing (claude/kilroy) ─────────
    //
    // Stamps are STATIC `{undo:true, redo:true}` (runtime failure classifies at
    // op time, never at stamp time). The marker bucket is LEDGER-SOURCED (r3 —
    // the record's entries union, durable even if the original's JSONL is
    // later compacted/GC'd; the read-time LCP projection stays out of the
    // bucket path). `canRedo` is the stored bit AND the chain-root recheck:
    // when `original_session_id` resolves, the ORIGINAL's tip is re-read at
    // snapshot time — a moved tip forces `canRedo:false` so no device shows a
    // redo Task 4 would refuse with REDO_REMOVED_HISTORY_COPY.

    use crate::rollback_record::{RollbackEntry, RollbackRecord};

    /// The display projection of `ids` out of the canonical uuid transcript —
    /// the verbatim turn JSON a Task 4 undo records into the ledger.
    fn removed_slice_for(ids: &[&str]) -> Vec<Value> {
        parse_transcript_turns("x", &uuid_transcript())
            .into_iter()
            .filter(|t| {
                t.get("turnId")
                    .and_then(Value::as_str)
                    .map(|id| ids.contains(&id))
                    .unwrap_or(false)
            })
            .collect()
    }

    /// The canonical two-op record: original `orig-id` (tip `a2`), can_redo
    /// stored true, one entry over [u2, a2] (last op at ms 100).
    fn claude_rollback_record(orig_id: &str, removed_turns: Vec<Value>) -> RollbackRecord {
        let mut record = RollbackRecord::empty(50);
        record.original_session_id = Some(orig_id.to_string());
        record.original_tip_uuid = Some("a2".to_string());
        record.push_entry(
            RollbackEntry {
                removed_turns,
                prompt_text: "prompt two".into(),
                at_ms: 90,
                epoch: 0,
            },
            100,
        );
        record.set_can_redo(true, 100);
        record
    }

    // ── Pending sessions: the snapshot of a session with no transcript yet
    //    comes from its genesis (core design §4.3, §4.5). ──

    const PENDING_ID: &str = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
    const PARENT_ID: &str = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";

    /// A store root with an empty `projects/` dir, plus `transcripts` written
    /// under `projects/-p/<id>.jsonl`.
    fn pending_store(transcripts: &[(&str, &str)]) -> tempfile::TempDir {
        let home = temp_home();
        let dir = home.path().join("projects").join("-p");
        std::fs::create_dir_all(&dir).unwrap();
        for (id, text) in transcripts {
            std::fs::write(dir.join(format!("{id}.jsonl")), text).unwrap();
        }
        home
    }

    fn recorded(
        genesis: crate::claude_launch::ClaudeGenesis,
        updated_at_ms: i64,
    ) -> crate::identity_sink::RecordedGenesis {
        crate::identity_sink::RecordedGenesis {
            genesis,
            updated_at_ms,
        }
    }

    fn fork_of(parent: &str, at: Option<&str>) -> crate::claude_launch::ClaudeGenesis {
        crate::claude_launch::ClaudeGenesis::Fork {
            parent: parent.to_string(),
            at: at.map(str::to_string),
            drops_turn: None,
        }
    }

    fn turn_ids(snapshot: &Value) -> Vec<String> {
        snapshot["turns"]
            .as_array()
            .expect("turns")
            .iter()
            .filter_map(|t| t["turnId"].as_str().map(str::to_string))
            .collect()
    }

    async fn pending(
        home: &tempfile::TempDir,
        id: &str,
        genesis: Option<&crate::identity_sink::RecordedGenesis>,
        rollback: Option<&crate::rollback_record::RollbackRecord>,
    ) -> Result<Value, ClaudeSnapshotError> {
        get_claude_snapshot_in(
            &[home.path().to_path_buf()],
            "freshclaude",
            id,
            genesis,
            rollback,
        )
        .await
    }

    /// §4.3 "create, no send": the snapshot is 200 with no turns, and its
    /// revision is the binding row's last write. Without a genesis the same miss
    /// is a lost session.
    #[tokio::test]
    async fn a_fresh_pending_session_serves_an_empty_snapshot() {
        let home = pending_store(&[]);
        let fresh = recorded(crate::claude_launch::ClaudeGenesis::Fresh, 5_000);
        let snapshot = pending(&home, PENDING_ID, Some(&fresh), None)
            .await
            .expect("a fresh pending session has a snapshot");
        assert!(turn_ids(&snapshot).is_empty());
        assert_eq!(snapshot["threadId"], PENDING_ID);
        assert_eq!(snapshot["sessionId"], PENDING_ID);
        assert_eq!(snapshot["latestTurnId"], Value::Null);
        assert_eq!(snapshot["revision"], json!(5_000));

        assert!(matches!(
            pending(&home, PENDING_ID, None, None).await,
            Err(ClaudeSnapshotError::NotFound)
        ));
    }

    /// §4.5: a pending fork shows its parent's conversation through the fork
    /// point, and the turn ids are the parent's line uuids, which the fork keeps
    /// (T6): the snapshot does not change when the fork's transcript appears.
    #[tokio::test]
    async fn a_pending_fork_serves_its_parents_prefix_with_the_turn_ids_the_fork_keeps() {
        let parent = uuid_transcript();
        let home = pending_store(&[(PARENT_ID, &parent)]);
        let fork = recorded(fork_of(PARENT_ID, Some("a1")), 6_000);
        let pending_snapshot = pending(&home, PENDING_ID, Some(&fork), None)
            .await
            .expect("a pending fork has a snapshot");
        assert_eq!(turn_ids(&pending_snapshot), vec!["u1", "a1"]);
        assert_eq!(pending_snapshot["threadId"], PENDING_ID);
        assert_eq!(pending_snapshot["sessionId"], PENDING_ID);
        assert_eq!(
            pending_snapshot["turns"][1]["items"][0]["text"],
            "answer one"
        );
        assert_eq!(pending_snapshot["revision"], json!(6_000));

        // The fork's first prompt writes its transcript: the kept prefix with the
        // parent's uuids (session id rewritten) between the CLI's bookend lines.
        let kept: Vec<String> = parent
            .lines()
            .take(2)
            .map(|line| {
                let mut obj: Value = serde_json::from_str(line).unwrap();
                obj["sessionId"] = json!(PENDING_ID);
                obj.to_string()
            })
            .collect();
        let materialized = [
            json!({"type":"mode","mode":"default","sessionId":PENDING_ID}).to_string(),
            kept.join("\n"),
            json!({"type":"last-prompt","lastPrompt":"prompt one","sessionId":PENDING_ID})
                .to_string(),
        ]
        .join("\n");
        std::fs::write(
            home.path()
                .join("projects/-p")
                .join(format!("{PENDING_ID}.jsonl")),
            materialized,
        )
        .unwrap();
        let materialized_snapshot = pending(&home, PENDING_ID, Some(&fork), None)
            .await
            .expect("the materialized fork has a snapshot");
        assert_eq!(
            materialized_snapshot["turns"], pending_snapshot["turns"],
            "the turns (ids included) are the same before and after the fork materializes"
        );
    }

    /// A fork with no point holds the whole parent; the prefix follows the raw
    /// parentUuid chain to the fork point, so a branch the parent abandoned (an
    /// in-file rewind) and a sidechain line never enter it.
    #[tokio::test]
    async fn a_pending_forks_prefix_is_the_parents_chain_to_the_fork_point() {
        let branched = [
            uuid_transcript(),
            json!({"type":"user","uuid":"u2b","parentUuid":"a1","timestamp":"t5","message":{"role":"user","content":[{"type":"text","text":"prompt two again"}]}}).to_string(),
            json!({"type":"assistant","uuid":"s1","isSidechain":true,"parentUuid":"u2b","timestamp":"t5b","message":{"role":"assistant","content":[{"type":"text","text":"sidechain noise"}]}}).to_string(),
            json!({"type":"assistant","uuid":"a2b","parentUuid":"u2b","timestamp":"t6","message":{"role":"assistant","content":[{"type":"text","text":"answer two again"}]}}).to_string(),
        ]
        .join("\n");
        let home = pending_store(&[(PARENT_ID, &branched)]);

        let whole = recorded(fork_of(PARENT_ID, None), 1);
        let snapshot = pending(&home, PENDING_ID, Some(&whole), None)
            .await
            .expect("a whole-parent fork has a snapshot");
        assert_eq!(turn_ids(&snapshot), vec!["u1", "a1", "u2b", "a2b"]);

        let abandoned = recorded(fork_of(PARENT_ID, Some("a2")), 1);
        let snapshot = pending(&home, PENDING_ID, Some(&abandoned), None)
            .await
            .expect("a fork on the abandoned branch has a snapshot");
        assert_eq!(turn_ids(&snapshot), vec!["u1", "a1", "u2", "a2"]);
    }

    /// A fork the CLI would refuse (its parent is gone, or no longer holds the
    /// fork point) reads as a lost session; an unreadable parent store is never
    /// lost.
    #[tokio::test]
    async fn a_pending_fork_without_its_fork_point_reads_as_gone() {
        let home = pending_store(&[(PARENT_ID, &uuid_transcript())]);
        let orphan = recorded(fork_of("d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0", None), 1);
        assert!(matches!(
            pending(&home, PENDING_ID, Some(&orphan), None).await,
            Err(ClaudeSnapshotError::NotFound)
        ));
        let missing_point = recorded(fork_of(PARENT_ID, Some("no-such-uuid")), 1);
        assert!(matches!(
            pending(&home, PENDING_ID, Some(&missing_point), None).await,
            Err(ClaudeSnapshotError::NotFound)
        ));
    }

    /// G28 for pending sessions: a store that cannot be checked is Io (500)
    /// whatever the genesis says, never a snapshot of the genesis (the
    /// transcript may be there) and never lost.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unreadable_store_is_io_for_a_pending_session_too() {
        let home = pending_store(&[]);
        let projects = home.path().join("projects");
        let Some(_locked) = UnreadableDir::make(&projects) else {
            return;
        };
        let fresh = recorded(crate::claude_launch::ClaudeGenesis::Fresh, 1);
        let result = pending(&home, PENDING_ID, Some(&fresh), None).await;
        assert!(
            matches!(result, Err(ClaudeSnapshotError::Io(_))),
            "expected Io, got {result:?}"
        );
    }

    /// The transcript is the truth once it exists: a genesis not yet cleared
    /// (the lazy clear runs after the first result) never hides it.
    #[tokio::test]
    async fn a_found_transcript_wins_over_a_genesis_not_yet_cleared() {
        let home = pending_store(&[(PENDING_ID, &uuid_transcript())]);
        let fresh = recorded(crate::claude_launch::ClaudeGenesis::Fresh, 1);
        let snapshot = pending(&home, PENDING_ID, Some(&fresh), None)
            .await
            .expect("the transcript serves");
        assert_eq!(turn_ids(&snapshot), vec!["u1", "a1", "u2", "a2"]);
    }

    /// A pending session after an undo carries the rollback record: its
    /// markers ride the pending snapshot and its last operation floors the
    /// revision, so the client's watermark never drops the post-undo snapshot.
    #[tokio::test]
    async fn a_pending_snapshots_revision_is_floored_by_the_rollback_record() {
        let home = pending_store(&[(PARENT_ID, &uuid_transcript())]);
        let mut record = claude_rollback_record(PARENT_ID, removed_slice_for(&["u2", "a2"]));
        // No chain-root recheck: it reads this process's store, not the test's.
        record.original_session_id = None;
        let fork = recorded(fork_of(PARENT_ID, Some("a1")), 7);
        let snapshot = pending(&home, PENDING_ID, Some(&fork), Some(&record))
            .await
            .expect("a pending fork has a snapshot");
        assert_eq!(turn_ids(&snapshot), vec!["u1", "a1"]);
        assert_eq!(snapshot["revision"], json!(record.last_op_at_ms));
        let bucket: Vec<&str> = snapshot["rolledBackTurns"]
            .as_array()
            .expect("the marker bucket")
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(bucket, vec!["u2", "a2"]);
    }

    /// Stage `<tmp>/projects/-p/{orig,cur}.jsonl` under CLAUDE_CONFIG_DIR and
    /// return (home guard, original id, current id) — env restored by the caller.
    fn stage_rollback_home(
        original_text: &str,
        current_text: &str,
    ) -> (tempfile::TempDir, String, String) {
        let home = temp_home();
        let dir = home.path().join("projects").join("-p");
        std::fs::create_dir_all(&dir).unwrap();
        let orig = "orig-rb-1";
        let cur = "cur-rb-1";
        std::fs::write(dir.join(format!("{orig}.jsonl")), original_text).unwrap();
        std::fs::write(dir.join(format!("{cur}.jsonl")), current_text).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        (home, orig.to_string(), cur.to_string())
    }

    #[tokio::test]
    async fn claude_snapshot_surfaces_the_ledger_bucket_and_rechecks_the_original_tip() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        let record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        let snap =
            build_claude_snapshot_json("freshclaude", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        assert_eq!(snap["capabilities"]["undo"], json!(true));
        assert_eq!(snap["capabilities"]["redo"], json!(true));
        let prefix: Vec<&str> = snap["turns"]
            .as_array()
            .expect("turns")
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(
            prefix,
            vec!["u1", "a1"],
            "turns[] is exactly what the model sees next"
        );
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        let ids: Vec<&str> = bucket.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(
            ids,
            vec!["u2", "a2"],
            "the marker bucket is the ledger entries union"
        );
        assert!(bucket.iter().all(|t| t["rolledBack"] == json!(true)));
        assert_eq!(bucket[0]["restorable"], json!(true), "u2 is restorable");
        assert_eq!(bucket[1]["restorable"], json!(true), "a2 is restorable");
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["u2"] }),
            "undoneDepth is the USER-role step count of the bucket"
        );
        assert_eq!(
            snap["revision"],
            json!(100),
            "the record's lastOpAtMs is the revision floor (basis 7 loses)"
        );
    }

    #[tokio::test]
    async fn claude_snapshot_a_moved_original_tip_forces_can_redo_false() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        // The original transcript was EXTENDED past the recorded tip (a new turn
        // landed on the chain root after the undo).
        let extended = format!(
            "{}\n{}",
            uuid_transcript(),
            json!({"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"t5","message":{"role":"user","content":[{"type":"text","text":"prompt three"}]}})
        );
        let (_home, orig, cur) = stage_rollback_home(&extended, &prefix_after_undo());
        let record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        let snap =
            build_claude_snapshot_json("freshclaude", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 1, "redoableTurnIds": [] }),
            "the chain-root tip is re-READ at snapshot time — no device shows a redo Task 4 would refuse"
        );
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(bucket.len(), 2);
        assert_eq!(
            bucket[0]["restorable"],
            json!(false),
            "u2 reads not-restorable even though the STORED bit is true — restorability \
             follows the provider-adjudicated canRedo param (the tip recheck)"
        );
        assert_eq!(
            bucket[1]["restorable"],
            json!(false),
            "a2 reads not-restorable for the same reason"
        );
    }

    #[tokio::test]
    async fn claude_snapshot_first_turn_undo_keeps_the_whole_bucket_and_can_redo() {
        // r2 first-turn leg: the current chain is EMPTY (fresh conversation);
        // entries carry ALL of [u1, a1, u2, a2] (recorded when the first-turn
        // undo ran).
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), "");
        let record = claude_rollback_record(&orig, removed_slice_for(&["u1", "a1", "u2", "a2"]));
        let snap = build_claude_snapshot_json("freshclaude", &cur, "", 0, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        let ids: Vec<&str> = bucket.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(ids, vec!["u1", "a1", "u2", "a2"]);
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 2, "redoableTurnIds": ["u1", "u2"] }),
            "live tip none ⇒ the recorded original tip counts as strictly beyond (two user steps in the bucket)"
        );
        assert!(snap["turns"].as_array().expect("turns").is_empty());
    }

    #[tokio::test]
    async fn claude_snapshot_the_bucket_is_the_entries_union_across_epochs() {
        // r3: frozen PRIOR-epoch markers precede the current epoch's, both in
        // conversation order; markers persist marked (the original transcript is
        // NOT needed to keep them).
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        let prior_epoch = vec![
            json!({ "id": "o1", "turnId": "o1", "ordinal": 0, "source": "durable", "role": "user", "summary": "old prompt", "items": [{ "id": "o1-i0", "kind": "text", "text": "old prompt" }] }),
            json!({ "id": "o2", "turnId": "o2", "ordinal": 1, "source": "durable", "role": "assistant", "summary": "old answer", "items": [{ "id": "o2-i0", "kind": "text", "text": "old answer" }] }),
        ];
        let mut record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        // F8 layout for a two-epoch record: the current-epoch entry carries the
        // bumped counter; the frozen prefix keeps its older epoch.
        record.current_epoch = 1;
        record.entries[0].epoch = 1;
        record.entries.insert(
            0,
            RollbackEntry {
                removed_turns: prior_epoch,
                prompt_text: "old prompt".into(),
                at_ms: 40,
                epoch: 0,
            },
        );
        let snap =
            build_claude_snapshot_json("freshclaude", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        let ids: Vec<&str> = bucket.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(
            ids,
            vec!["o1", "o2", "u2", "a2"],
            "frozen prior-epoch markers first (conversation order), then the current epoch's"
        );
        assert!(bucket.iter().all(|t| t["rolledBack"] == json!(true)));
        assert_eq!(
            bucket[0]["restorable"],
            json!(false),
            "o1 — frozen prior-epoch marker"
        );
        assert_eq!(
            bucket[1]["restorable"],
            json!(false),
            "o2 — frozen prior-epoch marker (assistant row too)"
        );
        assert_eq!(
            bucket[2]["restorable"],
            json!(true),
            "u2 — current-epoch marker"
        );
        assert_eq!(
            bucket[3]["restorable"],
            json!(true),
            "a2 — current-epoch marker (assistant row too)"
        );
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 2, "redoableTurnIds": ["u2"] }),
            "undoneDepth counts USER turns across the whole union (o1, u2); F6: the frozen \
             prior-epoch user marker (o1) is NOT redoable — only the current epoch's tail is"
        );
    }

    #[tokio::test]
    async fn claude_snapshot_destroyed_redo_keeps_the_marked_bucket() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        let mut record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        record.destroy_redo(120); // decision 5: kills redo, NEVER the markers (decision 6)
        let snap =
            build_claude_snapshot_json("freshclaude", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(bucket.len(), 2);
        assert_eq!(
            bucket[0]["restorable"],
            json!(false),
            "u2 — destroyed redo ⇒ collapsed history, never restorable"
        );
        assert_eq!(bucket[1]["restorable"], json!(false), "a2 — same");
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 1, "redoableTurnIds": [] })
        );
        assert_eq!(
            snap["revision"],
            json!(120),
            "the destroy also lifts the floor"
        );
    }

    #[tokio::test]
    async fn kilroy_snapshot_stamps_identically_to_freshclaude() {
        // One assertion leg re-runs the whole fixture with session_type "kilroy"
        // (identical stamps — the SAME overlay/builder lane serves both).
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        let record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        let snap =
            build_claude_snapshot_json("kilroy", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(snap["sessionType"], json!("kilroy"));
        assert_eq!(snap["capabilities"]["undo"], json!(true));
        assert_eq!(snap["capabilities"]["redo"], json!(true));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["u2"] })
        );
        assert_eq!(snap["rolledBackTurns"].as_array().expect("bucket").len(), 2);
    }

    #[test]
    fn claude_snapshot_without_a_record_stamps_static_caps_but_hides_the_rollback_keys() {
        let snap = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 7, None);
        // Stamps are static and presence-independent (rollback refusal is at op
        // time, never at stamp time).
        assert_eq!(snap["capabilities"]["undo"], json!(true));
        assert_eq!(snap["capabilities"]["redo"], json!(true));
        assert!(snap.get("rolledBackTurns").is_none());
        assert!(snap.get("rollback").is_none());
        assert_eq!(snap["revision"], json!(7), "no floor without a record");
    }

    #[tokio::test]
    async fn get_claude_snapshot_floors_the_revision_at_the_record() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        // Re-key the record to the CURRENT id (the adoption leg's ledger move):
        // ops stamped an hour in the future, so the transcript's fresh mtime
        // ALWAYS loses — the floor is asserted deterministically end-to-end.
        let mut record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        let far_future = crate::rollback_record::now_ms() + 3_600_000;
        record.set_can_redo(true, far_future);
        let snap = get_claude_snapshot("freshclaude", &cur, Some(&record))
            .await
            .expect("snapshot builds");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(snap["revision"], json!(far_future));
        assert_eq!(snap["rolledBackTurns"].as_array().expect("bucket").len(), 2);
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["u2"] })
        );
    }
}

#[cfg(test)]
#[path = "claude_snapshot_real_cli_tests.rs"]
pub(crate) mod real_cli_tests;
