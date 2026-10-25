//! Claude SessionStart signal watcher + mid-session rebind (P4).
//!
//! Task 11's launch wiring injects a `SessionStart` hook into every claude
//! terminal-pane launch that writes the hook's stdin JSON atomically to
//! `$HOME/.freshell/session-signals/claude/<FRESHELL_TERMINAL_ID>__<nonce>.json`.
//! This module is the consumer: a periodic sweep drains those signal files and
//! moves a live claude pane's identity when the CLI reports a NEW session id
//! mid-session (in-TUI `/resume`, `/clear`, ...), so a later restore resumes
//! the id the user actually ended on -- deterministic (the CLI itself reports
//! the id), no heuristic coordinator port.
//!
//! Deliberate design: NO new `WsState` field -- the watcher is owned by the
//! sweep task (every integration test constructs `WsState` as an exhaustive
//! literal; a new field would touch ~27 test files for nothing).
//!
//! Drain is NON-DESTRUCTIVE for valid signals -- the consumer deletes a file
//! only after acting on it (act-then-delete, D1.1, mirroring
//! opencode_signal.rs): a signal for a terminal id unknown to this instance
//! is RETAINED so the owning instance (another freshell server sharing
//! $HOME) can consume it, bounded by opencode_signal's STALE_SIGNAL_MAX_AGE.
//! Foreign-provider signals are warn-logged and consumed
//! (`SignalDisposition::Discard`); orphaned `.tmp` staging is reaped on the
//! same TTL.

use std::path::{Path, PathBuf};

use crate::terminal::now_ms;
use crate::WsState;

/// Sweep cadence -- mirrors the locator sweeps' ~1s-order polling shape
/// (`spawn_codex_locator_sweep`); signal files are rare (one per SessionStart
/// event) so 1s is comfortably fresh and comfortably cheap.
const CLAUDE_SIGNAL_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Drains `*.json` signal files from one directory. Owned by the sweep task
/// (or a test) -- deliberately not stored in `WsState`. `Clone` (a bare
/// `PathBuf`) so the sweep can hand a copy to `spawn_blocking`.
#[derive(Clone)]
pub struct ClaudeSignalWatcher {
    root: PathBuf,
}

/// One parsed SessionStart signal: which pane reported which session id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeSignal {
    pub terminal_id: String,
    pub session_id: String,
    /// SessionStart's `source` field: "startup" | "resume" | "clear" | ...
    pub source: Option<String>,
    /// The backing file, retained by `drain()` -- the consumer deletes it
    /// only after acting on or explicitly discarding the signal (D1.1).
    pub path: std::path::PathBuf,
}

impl ClaudeSignalWatcher {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The root Task 11's hook command writes into:
    /// `$HOME/.freshell/session-signals/claude` (`%USERPROFILE%` on Windows).
    /// `None` when the home env var is unresolvable -- the boot wiring skips
    /// the sweep in that case (mirrors `codex_sessions_root`'s convention).
    pub fn default_root() -> Option<PathBuf> {
        #[cfg(windows)]
        let base = std::env::var("USERPROFILE").ok()?;
        #[cfg(not(windows))]
        let base = std::env::var("HOME").ok()?;
        if base.is_empty() {
            return None;
        }
        Some(
            PathBuf::from(base)
                .join(".freshell")
                .join("session-signals")
                .join("claude"),
        )
    }

    /// Read+parse every `*.json` in the root; valid files are RETAINED (the
    /// consumer act-then-deletes, D1.1). Filename:
    /// `<terminal_id>__<nonce>.json` -- the terminal id is recovered by
    /// splitting the stem on the LAST `__` (`rsplit_once`): the nonce
    /// (`<timestamp>-<pid>` digits and `-`) can never contain `__`, so a LAST-split
    /// always recovers the full terminal id even if an id ever contained
    /// `__`. Fresh `*.tmp` staging files are ignored; stale ones (orphaned by a dead hook) are reaped on `STALE_SIGNAL_MAX_AGE`, as are unconsumed `*.json` files older than the same TTL. Malformed files are warn-logged (`claude_signal_rejected`) and deleted.
    /// drain() sorts by filename (timestamp-first nonces => deterministic
    /// last-write-wins under rapid A->B->A switching on nanosecond-precision
    /// date; the second-granularity fallback degrades same-second order to pid
    /// order).
    pub fn drain(&self) -> Vec<ClaudeSignal> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new(); // no dir yet: no claude pane has ever signaled
        };
        let mut paths: Vec<std::path::PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            match path.extension().and_then(|e| e.to_str()) {
                Some("json") => paths.push(path),
                Some("tmp") => {
                    // Orphaned atomic-write staging (hook died before the
                    // rename): reap on the shared TTL so junk stays bounded
                    // (mirrors opencode_signal.rs:146-157).
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > crate::opencode_signal::STALE_SIGNAL_MAX_AGE);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    }
                }
                _ => {}
            }
        }
        // Deterministic last-write-wins (#575): timestamp-first, width-stable
        // producer nonces make a filename sort emission order.
        paths.sort();
        let mut signals = Vec::new();
        for path in paths {
            let stale = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > crate::opencode_signal::STALE_SIGNAL_MAX_AGE);
            if stale {
                let _ = std::fs::remove_file(&path); // retention cap (D1.1)
                continue;
            }
            match parse_signal_file(&path) {
                // Retained: consumer act-then-deletes (D1.1).
                Some(sig) => signals.push(sig),
                None => {
                    // A silently-never-firing lane is the failure mode to
                    // avoid (A8 detectability): log rejects before consuming.
                    tracing::warn!(path = %path.display(),
                        "claude_signal_rejected: bad terminal id or session_id, consuming file");
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        signals
    }
}

/// Parse one signal file: terminal id from the filename stem (LAST `__`),
/// `session_id` (required non-empty) + `source` from the JSON body.
fn parse_signal_file(path: &Path) -> Option<ClaudeSignal> {
    let stem = path.file_stem()?.to_str()?;
    let (terminal_id, _nonce) = stem.rsplit_once("__")?;
    if terminal_id.is_empty() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let body: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let session_id = body.get("session_id")?.as_str()?;
    if session_id.is_empty() {
        return None;
    }
    Some(ClaudeSignal {
        terminal_id: terminal_id.to_string(),
        session_id: session_id.to_string(),
        source: body
            .get("source")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        path: path.to_path_buf(),
    })
}

/// Sweep body: drain signals; for each, no-op if the id matches the pane's
/// current claude identity; otherwise guarded rebind (same guard set as the
/// codex fork rebind, same pinned side-effect order as the codex tail).
///
/// `pub` (not `pub(crate)`): the integration test
/// (`tests/claude_session_rebind.rs`) drives drains directly for determinism
/// instead of racing a spawned sweep timer.
pub async fn drain_and_rebind_claude(state: &WsState, watcher: &ClaudeSignalWatcher) {
    // `drain()` is synchronous fs I/O (read_dir + read + remove per signal
    // file); run it on the blocking pool like the codex locator lanes
    // (30a34360) instead of on the async runtime inside the 1s sweep.
    // `drain()` itself stays synchronous -- only the call site moves.
    let drain_watcher = watcher.clone();
    let signals = match tokio::task::spawn_blocking(move || drain_watcher.drain()).await {
        Ok(signals) => signals,
        Err(join_error) => {
            tracing::warn!(
                error = %join_error,
                "claude_signal_drain_panicked: blocking drain task panicked, skipping this cycle"
            );
            return;
        }
    };
    for sig in signals {
        match apply_claude_signal(state, &sig).await {
            SignalDisposition::Acted | SignalDisposition::Discard => {
                let _ = std::fs::remove_file(&sig.path); // act/discard-then-delete (D1.1)
            }
            // Not actionable YET (or not this instance's pane) => the file
            // stays for a later sweep; STALE_SIGNAL_MAX_AGE bounds it.
            SignalDisposition::Retain => {}
        }
    }
}

/// Outcome of applying one signal: `Acted` (rebind done, same-id no-op, or
/// deliberate guard refusal), `Retain` (might become actionable later, or
/// belongs to another freshell instance sharing $HOME -- keep the file for
/// the next sweep; STALE_SIGNAL_MAX_AGE bounds orphans), `Discard`
/// (permanently unactionable -- consume the file so it neither accumulates
/// nor re-logs; deleting a signal degrades only to no-rebind).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalDisposition {
    Acted,
    Retain,
    Discard,
}

/// One signal through the guard ladder. Returns the file's disposition:
/// `Acted` and `Discard` delete the file; `Retain` keeps it for a later
/// sweep. Mirrors opencode_signal.rs::apply_opencode_signal -- CONSUMPTION
/// semantics only: claude rebind POLICY (no first-bind via signal, no
/// retired-pane ref move) is deliberately unchanged.
async fn apply_claude_signal(state: &WsState, sig: &ClaudeSignal) -> SignalDisposition {
    // Registry row: must be a live claude pane.
    let Some(current) = state.identity.get(&sig.terminal_id) else {
        // NEW: no identity row. Fresh claude panes seed their identity row
        // synchronously at create (terminal.rs preallocation), so this is
        // either a pane belonging to ANOTHER freshell instance sharing
        // $HOME (retain so the owner can consume it) or a transient create
        // race (retain until the row lands). Foreign-provider registry rows
        // are permanently unactionable: discard with a log.
        let Some(entry) = state.registry.probe(&sig.terminal_id) else {
            return SignalDisposition::Retain; // unknown terminal: not ours (yet)
        };
        if entry.mode != "claude" {
            tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
                mode = %entry.mode, source = ?sig.source,
                "claude_signal_ignored: pane belongs to another provider, consuming file");
            return SignalDisposition::Discard;
        }
        return SignalDisposition::Retain; // claude pane whose identity row hasn't landed yet
    };
    if current.provider.as_deref() != Some("claude") {
        // NEW: foreign-provider identity row -- never touch the pane
        // (one-writer / D7) and never actionable (a pane's provider does
        // not change), so consume instead of silently re-reading it.
        tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            provider = ?current.provider, source = ?sig.source,
            "claude_signal_ignored: identity row belongs to another provider, consuming file");
        return SignalDisposition::Discard;
    }
    if current.retired {
        // Policy unchanged: no retired-pane rebind for claude. A deliberate
        // refusal counts as acted on (consume -- bounded noise).
        return SignalDisposition::Acted;
    }
    if current.session_id.as_deref() == Some(sig.session_id.as_str()) {
        // Load-bearing no-op (A7): SessionStart also fires on `startup`
        // and on EVERY compaction (`compact`) with session_id == bound
        // id -- one signal file per compaction. Same-id signals must
        // stay silent no-ops; keep this guard.
        return SignalDisposition::Acted;
    }
    // A13: the claimed id must have no live owner.
    if let Some(owner) =
        state
            .registry
            .live_session_owner(Some(&state.identity), "claude", &sig.session_id)
    {
        tracing::warn!(terminal_id = %sig.terminal_id, owner = %owner,
            "claude_rebind_refused: target session already live-owned (A13)");
        return SignalDisposition::Acted;
    }
    // Ledger A8 (retired-inclusive) + freshclaude guard, mirroring codex
    // Guard A/C semantics.
    if let Some(existing) = state
        .identity
        .find_by_session_including_retired("claude", &sig.session_id)
    {
        if existing != sig.terminal_id {
            tracing::warn!(terminal_id = %sig.terminal_id,
                "claude_rebind_refused: session_bound_elsewhere");
            return SignalDisposition::Acted;
        }
    }
    // Cross-kind (D7): a LIVE freshclaude sidecar owning this session is
    // just as much "the one writer on S's JSONL" as a live PTY. The
    // durable ledger guard below is blind to a sidecar whose row hasn't
    // landed yet. Mirrors codex_claim_refused (codex_identity.rs:159).
    if state.fresh_claude.has_live_session(&sig.session_id).await {
        tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            "claude_rebind_refused: freshagent_live_session");
        return SignalDisposition::Acted;
    }
    if state
        .pane_ledger
        .lookup_by_session("claude", &sig.session_id)
        .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
    {
        // NEW (was a bare continue): warn for detectability -- bounded
        // because the refused file is consumed in the same pass.
        tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            "claude_rebind_refused: ledger_fresh_agent_session");
        return SignalDisposition::Acted;
    }
    let previous = current.session_id.clone();
    // b8ke ext r14 F1/F2: the signal rebind acquires its coordinator
    // authority FIRST (fail-closed: a refusal mutates NO identity home —
    // the file is consumed as acted, the next SessionStart retries) and
    // holds it across the identity homes' writes; the commit is the
    // atomic move (new Live + old Aliased in ONE lock scope, the retained
    // claim rekeyed — never both keys naming the writer).
    let Some(authority) = crate::identity_ownership::coordinator_begin_identity(
        state,
        "claude",
        &sig.terminal_id,
        &sig.session_id,
        previous.as_deref(),
    )
    .await
    else {
        return SignalDisposition::Acted;
    };
    tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
        source = ?sig.source, "claude_rebind: SessionStart reported a new session id");
    // Same pinned order as the codex tail, with the b8ke ext r39 F2
    // reorder: durable ledger (awaited) -> identity -> meta -> activity
    // hub -> associated. The binding write GATES THE INSTALL/ANNOUNCE —
    // on failure NOTHING installs or announces (the identity homes keep
    // the consistent prior state) and the held authority COMMITS (the
    // live CLI process is the new session's writer — never a
    // Vacant-with-live-writer; a failed ticket would let a later
    // lifecycle command start a second writer beside it). Pre-r39 the
    // upsert/meta/hub/associated broadcast all landed BEFORE the
    // awaited binding write and the failure unwound to a Vacant key
    // while the registries and clients still identified the terminal as
    // the session writer.
    let binding_ok = crate::pane_ledger::ledger_resolve_identity(
        state,
        &sig.terminal_id,
        "claude",
        &sig.session_id,
        current.cwd.as_deref(),
    )
    .await;
    if !binding_ok {
        tracing::warn!(target: "freshell_ws::claude_signal",
            terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            event = "claude_signal.binding_failed",
            outcome = "committed_owner_kept",
            failure_reason = "DURABLE_BINDING_WRITE_FAILED",
            "claude_signal_binding_failed: the durable binding write failed — \
             nothing installed/announced; the held authority commits so the \
             live CLI writer stays the named owner (never a \
             Vacant-with-live-writer); the next SessionStart signal re-adopts \
             and retries the binding"
        );
        crate::identity_ownership::coordinator_commit_identity(
            state,
            authority,
            "claude",
            &sig.terminal_id,
            &sig.session_id,
            previous.as_deref(),
        )
        .await;
        return SignalDisposition::Acted;
    }
    state.identity.upsert(
        &sig.terminal_id,
        Some("claude"),
        Some(&sig.session_id),
        current.cwd.as_deref(),
        now_ms(),
    );
    // Unified agent names (Task 2): the SessionStart identity move. The
    // upsert established the durable identity and retargets only an
    // ALREADY-DURABLE name ref (the switch rule: an established binding
    // follows its session); a still-pending ref waits HERE for its
    // first-bind transfer — the stashed pending handle transfers onto the
    // reported session with the EXISTING claude durability evidence: the CLI
    // writes the session transcript at startup, so a located transcript
    // verifies the binding (a zero-turn miss keeps the handle pending —
    // InitialRecovery updates the acquired location only, never the name
    // authority; the main.rs naming tick retries the verified transition).
    {
        let selected = freshell_freshagent::locate_transcript_selected(&sig.session_id);
        let (persistence, evidence) = if selected.is_some() {
            (
                freshell_protocol::native_location::NativePersistence::Verified,
                freshell_protocol::native_location::NativeEvidenceKind::SelectedTranscript,
            )
        } else {
            (
                freshell_protocol::native_location::NativePersistence::Prospective,
                freshell_protocol::native_location::NativeEvidenceKind::InitializedRuntime,
            )
        };
        let acquisition = freshell_protocol::native_location::NativeAcquisition {
            location: freshell_protocol::native_location::NativeLocation::Claude {
                config_root: selected
                    .as_ref()
                    .map(|s| s.config_root.display().to_string())
                    .unwrap_or_default(),
                transcript_path: selected
                    .as_ref()
                    .map(|s| s.transcript_path.display().to_string()),
                project_directory_key: None,
                transcript_cwd: selected.as_ref().and_then(|s| s.transcript_cwd.clone()),
                effective_project_key_override: None,
            },
            evidence,
            persistence,
        };
        if persistence == freshell_protocol::native_location::NativePersistence::Verified {
            crate::identity::bind_pending_naming(
                &state.identity,
                &state.registry,
                &sig.terminal_id,
                freshell_protocol::session_names::NamedProvider::Claude,
                &sig.session_id,
                acquisition,
            )
            .await;
        } else if let Some(sink) = state.identity.naming() {
            // Zero-turn: retain the handle; record only the acquired location
            // (the main.rs naming tick retries the verified transition).
            if let Some(handle) = state.identity.naming_handle_of(&sig.terminal_id) {
                let pending =
                    freshell_protocol::session_names::SessionNameRef::Pending { id: handle };
                if let Err(error) = sink.record_acquisition(pending.clone(), acquisition).await {
                    // Structured failure log under THIS crate's target.
                    tracing::warn!(
                        target: "freshell_ws::naming",
                        op = "record_acquisition",
                        name_ref = %freshell_freshagent::naming::name_ref_debug_key(&pending),
                        revision = error.log_revision(),
                        class = %error.code(),
                        "session_names.operation_failed: {error}"
                    );
                }
            }
        }
    }
    // Name reliability (Task 10, G45): a conversation switch moved the
    // identity's durable ref; the terminal row's binding follows it and the
    // row adopts the new session's own name.
    crate::terminal_naming::follow_identity_switch(state, &sig.terminal_id).await;
    state.registry.set_meta(
        &sig.terminal_id,
        None,
        None,
        Some("claude".to_string()),
        Some(sig.session_id.clone()),
    );
    // #606/#611: the activity tracker must follow the rebind or every
    // later JSONL probe targets a stale session (validated: zero
    // production bind_session callers before this line).
    if let Some(hub) = state.activity.as_ref() {
        hub.bind_claude_session(&sig.terminal_id, &sig.session_id);
    }
    crate::codex_identity::broadcast_terminal_session_associated(
        state,
        "claude",
        &sig.terminal_id,
        &sig.session_id,
        current.cwd.clone(),
        previous.clone(),
    );
    crate::identity_ownership::coordinator_commit_identity(
        state,
        authority,
        "claude",
        &sig.terminal_id,
        &sig.session_id,
        previous.as_deref(),
    )
    .await;
    SignalDisposition::Acted
}

/// Spawned by `freshell-server` boot next to the locator sweeps (mirrors
/// `spawn_codex_locator_sweep`'s task shape): periodically drain the signal
/// root and process any rebinds, off the per-connection select loops.
pub fn spawn_claude_signal_sweep(state: WsState, watcher: ClaudeSignalWatcher) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(CLAUDE_SIGNAL_SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            drain_and_rebind_claude(&state, &watcher).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_parses_retains_valid_files_and_consumes_rejects() {
        // Guard, not asserted on: this test's junk__1.json hits the
        // `claude_signal_rejected` warn callsite. Under parallel test
        // execution, the FIRST thread to hit a callsite registers its
        // interest; with a single registered dispatcher, tracing-core's
        // `JustOne` rebuilder computes interest from the REGISTERING
        // thread's default subscriber -- none here would cache
        // `Interest::never` globally and silently swallow the warn that
        // drain_warns_on_rejected_files asserts on. Installing the
        // process-global capture (kata 59nb: one global subscriber; every
        // thread's events land in the shared vec) makes registration always
        // see a live subscriber, whichever thread registers first.
        let _ = crate::invariants::capture::capture();
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "term-a__0000000000000000001-1.json",
            r#"{"session_id":"new-id","source":"resume","cwd":"/tmp/x","hook_event_name":"SessionStart"}"#,
        );
        write_file(dir.path(), "junk__1.json", "not json");
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].terminal_id, "term-a");
        assert_eq!(signals[0].session_id, "new-id");
        assert_eq!(signals[0].source.as_deref(), Some("resume"));
        assert_eq!(
            signals[0].path,
            dir.path().join("term-a__0000000000000000001-1.json")
        );
        assert!(
            signals[0].path.exists(),
            "drain must NOT delete valid signal files: act-then-delete is the \
             consumer's job (D1.1) -- a second instance sharing $HOME must not \
             destroy signals it cannot act on"
        );
        assert!(
            !dir.path().join("junk__1.json").exists(),
            "malformed files stay single-shot (consumed)"
        );
        // Retention is stable: a second drain sees the same signal again.
        assert_eq!(
            watcher.drain().len(),
            1,
            "retained file re-emitted next sweep"
        );
    }

    #[test]
    fn drain_returns_signals_sorted_by_filename_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        // Timestamp-first nonces (Task 1 shape). Written in REVERSE of
        // emission order so read_dir/creation order cannot fake a pass.
        let emissions = [
            (
                "1769000000000000001-11",
                "aaaaaaaa-0000-4000-8000-000000000001",
            ),
            (
                "1769000000000000002-11",
                "aaaaaaaa-0000-4000-8000-000000000002",
            ),
            (
                "1769000000000000003-99",
                "aaaaaaaa-0000-4000-8000-000000000003",
            ),
            (
                "1769000000000000004-42",
                "aaaaaaaa-0000-4000-8000-000000000004",
            ),
            (
                "1769000000000000005-42",
                "aaaaaaaa-0000-4000-8000-000000000005",
            ),
            (
                "1769000000000000006-07",
                "aaaaaaaa-0000-4000-8000-000000000006",
            ),
        ];
        for (nonce, sid) in emissions.iter().rev() {
            std::fs::write(
                dir.path().join(format!("t1__{nonce}.json")),
                format!(r#"{{"session_id":"{sid}","source":"resume"}}"#),
            )
            .unwrap();
        }
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        let got: Vec<&str> = signals.iter().map(|s| s.session_id.as_str()).collect();
        let want: Vec<&str> = emissions.iter().map(|(_, sid)| *sid).collect();
        assert_eq!(got, want, "drain must be filename-sorted (emission order)");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            6,
            "valid signals are RETAINED by drain (act-then-delete)"
        );
    }

    fn write_file(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    /// Backdate a file's mtime past the retention cap (mirrors
    /// opencode_signal.rs::drain_reaps_stale_files_without_emitting).
    fn backdate_past_ttl(path: &std::path::Path) {
        let stale = std::time::SystemTime::now()
            - crate::opencode_signal::STALE_SIGNAL_MAX_AGE
            - std::time::Duration::from_secs(60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(stale)
            .unwrap();
    }

    #[test]
    fn drain_reaps_stale_files_without_emitting() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "t1__0000000000000000001-1.json",
            r#"{"session_id":"old-id","source":"resume"}"#,
        );
        let path = dir.path().join("t1__0000000000000000001-1.json");
        backdate_past_ttl(&path);
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert!(
            signals.is_empty(),
            "stale signals must be reaped, not emitted"
        );
        assert!(
            !path.exists(),
            "stale signal file must be deleted (retention cap)"
        );
    }

    #[test]
    fn drain_reaps_stale_tmp_staging_files_but_keeps_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "t1__0000000000000000001-1.tmp", "partial write");
        write_file(dir.path(), "t2__0000000000000000002-1.tmp", "in flight");
        backdate_past_ttl(&dir.path().join("t1__0000000000000000001-1.tmp"));
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert!(signals.is_empty());
        assert!(
            !dir.path().join("t1__0000000000000000001-1.tmp").exists(),
            "orphaned .tmp (writer died before rename) must be reaped on the TTL"
        );
        assert!(
            dir.path().join("t2__0000000000000000002-1.tmp").exists(),
            "fresh in-flight .tmp must be left alone"
        );
    }

    #[test]
    fn drain_on_missing_directory_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = ClaudeSignalWatcher::new(dir.path().join("never-created"));
        assert!(
            watcher.drain().is_empty(),
            "missing root: empty drain, no panic"
        );
    }

    #[test]
    fn drain_warns_on_rejected_files() {
        let events = crate::invariants::capture::capture();
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "junk__1.json", "not json");
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert!(signals.is_empty());
        assert!(
            !dir.path().join("junk__1.json").exists(),
            "malformed files stay single-shot (consumed)"
        );
        // Collect-then-assert (never hold the shared vec's guard across an
        // assert); the path filter scopes the presence check to THIS test's
        // junk file — the vec carries every test's events (kata 59nb).
        let want_path = format!("{}", dir.path().join("junk__1.json").display());
        let hits: Vec<crate::invariants::capture::CapturedEvent> = {
            let events = events.lock().unwrap_or_else(|p| p.into_inner());
            events
                .iter()
                .filter(|e| {
                    e.message.contains("claude_signal_rejected")
                        && e.fields.get("path").map(String::as_str) == Some(want_path.as_str())
                })
                .cloned()
                .collect()
        };
        assert!(
            !hits.is_empty(),
            "parse rejects must be warn-logged for detectability (A8); got: {hits:?}"
        );
    }
}
