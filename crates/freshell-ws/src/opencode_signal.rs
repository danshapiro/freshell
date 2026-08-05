//! Opencode mid-session rebind: signal-file watcher.
//!
//! The freshell TUI plugin (extensions/opencode/freshell-rebind-plugin.ts,
//! injected per-pane via OPENCODE_TUI_CONFIG pointing at the freshell-owned
//! plugin-only tui.json) writes
//! `$HOME/.freshell/session-signals/opencode/<terminal_id>__<nonce>.json`
//! on every in-TUI session switch. This module drains those files.
//!
//! Shape-mirrors claude_signal.rs (the codebase prefers duplication over a
//! premature provider-generic controller — see codex_association.rs:4-6),
//! with three deltas: drain() sorts by filename (timestamp-first nonces ⇒
//! deterministic last-write-wins under rapid A→B→A switching); session ids
//! must match `ses_[A-Za-z0-9]+` (opencode's id shape; reject everything
//! else before any guard runs, warn-logging rejects for detectability);
//! and drain is NON-DESTRUCTIVE for valid signals — the consumer deletes a
//! file only after acting on it (act-then-delete, D1.1), with a ~10-minute
//! staleness reap for signals nobody ever acts on. Two bounded-junk rules:
//! signals addressed to a FOREIGN-provider pane are permanently
//! unactionable (a pane's mode/provider never changes), so they are
//! warn-logged once and consumed (`SignalDisposition::Discard`) instead of
//! being silently re-read every sweep; and orphaned `.tmp` staging files
//! (writer died before the rename) are reaped on the same staleness TTL.
//!
//! Deliberately NOT a WsState field: the sweep task owns the watcher
//! (claude_signal.rs:12-14 — WsState is an exhaustive struct literal in
//! ~27 test files).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use freshell_protocol::TerminalRunStatus;
use freshell_terminal::registry::IdentityProbeRow;

use crate::terminal::now_ms;
use crate::WsState;

/// Retention cap for unacted signal files (D1.1): a signal whose pane never
/// (re)appears is reaped after this age instead of living forever.
pub(crate) const STALE_SIGNAL_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

/// Plugin-alive heartbeat state, owned by the watcher so
/// `drain_and_rebind_opencode`'s signature stays unchanged (WsState is an
/// exhaustive struct literal in ~27 test files -- deliberately not touched).
#[derive(Debug, Default)]
pub(crate) struct HelloTracker {
    /// terminalIds that have ever said hello (plugin proven alive).
    pub(crate) seen: HashSet<String>,
    /// terminalIds already warned about -- once per terminal, ever.
    pub(crate) warned: HashSet<String>,
}

#[derive(Clone)]
pub struct OpencodeSignalWatcher {
    root: PathBuf,
    hello: Arc<Mutex<HelloTracker>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeSignal {
    /// The signal file itself. The consumer deletes it only after ACTING on
    /// the signal (act-then-delete, D1.1) — never delete-on-read.
    pub path: PathBuf,
    pub terminal_id: String,
    pub session_id: String,
    /// The plugin's `source` field ("opencode-tui-plugin"); logged only.
    pub source: Option<String>,
}

pub(crate) fn is_valid_opencode_session_id(id: &str) -> bool {
    id.strip_prefix("ses_")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// One drain pass over the signal root, split by payload kind.
#[derive(Debug, Default)]
pub struct OpencodeDrainOutcome {
    /// Rebind signals, oldest first. The consumer act-then-deletes these.
    pub rebinds: Vec<OpencodeSignal>,
    /// terminalIds whose plugin-alive hello was consumed this pass
    /// (delete-on-read: a hello is proof of life, not a command).
    pub hellos: Vec<String>,
}

enum ParsedSignal {
    Rebind(OpencodeSignal),
    /// `{"hello":true,...}` -- written once at TUI startup by the rebind
    /// plugin as a plugin-alive heartbeat. Carries no session id and can
    /// never enter the rebind ladder.
    Hello {
        terminal_id: String,
    },
}

impl OpencodeSignalWatcher {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            hello: Arc::default(),
        }
    }

    /// `$HOME` (unix) / `%USERPROFILE%` (windows) + `.freshell/session-signals/opencode`.
    /// `None` when home is unresolvable — boot skips the sweep (mirrors
    /// ClaudeSignalWatcher::default_root).
    pub fn default_root() -> Option<PathBuf> {
        // Copy the body of ClaudeSignalWatcher::default_root (claude_signal.rs:52-66)
        // verbatim, changing the final path segment from "claude" to "opencode".
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
                .join("opencode"),
        )
    }

    /// Read + parse every `*.json`, sorted by filename. Valid rebind signals
    /// are returned WITH their file paths and RETAINED on disk —
    /// act-then-delete is the consumer's job (D1.1: a fire-and-forget drain
    /// permanently lost signals when a pane died within seconds of a switch,
    /// V6). `{"hello":true,...}` plugin-alive heartbeats are delete-on-read
    /// (proof of life, not a command) and reported via
    /// [`OpencodeDrainOutcome::hellos`]. Malformed and invalid-shape files
    /// are warn-logged (`opencode_signal_rejected`) and deleted (single-shot
    /// semantics — junk must not re-fail every sweep). Files older than
    /// STALE_SIGNAL_MAX_AGE are reaped without emitting. Fresh `*.tmp`
    /// staging files are ignored; stale ones (orphaned by a dead writer) are
    /// reaped on the same TTL.
    pub fn drain(&self) -> OpencodeDrainOutcome {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            // no dir yet: no opencode pane has ever signaled
            return OpencodeDrainOutcome::default();
        };
        let mut paths: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            match path.extension().and_then(|e| e.to_str()) {
                Some("json") => paths.push(path),
                Some("tmp") => {
                    // Orphaned atomic-write staging (writer died before the
                    // rename): reap on the same TTL so junk stays bounded.
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > STALE_SIGNAL_MAX_AGE);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    }
                }
                _ => {}
            }
        }
        paths.sort();
        let mut outcome = OpencodeDrainOutcome::default();
        for path in paths {
            let stale = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STALE_SIGNAL_MAX_AGE);
            if stale {
                let _ = std::fs::remove_file(&path); // retention cap (D1.1)
                continue;
            }
            match parse_signal_file(&path) {
                // Retained: consumer act-then-deletes.
                Some(ParsedSignal::Rebind(sig)) => outcome.rebinds.push(sig),
                Some(ParsedSignal::Hello { terminal_id }) => {
                    let _ = std::fs::remove_file(&path); // delete-on-read
                    outcome.hellos.push(terminal_id);
                }
                None => {
                    // A silently-never-firing lane is the failure mode to
                    // avoid (A8 detectability): log rejects before consuming.
                    tracing::warn!(path = %path.display(),
                        "opencode_signal_rejected: bad terminal id or session_id shape, consuming file");
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        outcome
    }
}

fn parse_signal_file(path: &Path) -> Option<ParsedSignal> {
    let stem = path.file_stem()?.to_str()?;
    let (terminal_id, _nonce) = stem.rsplit_once("__")?; // LAST "__" — load-bearing
    if terminal_id.is_empty() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let body: serde_json::Value = serde_json::from_str(&raw).ok()?;
    // Hello discrimination comes BEFORE session_id validation: a hello
    // carries no session id and must never hit the reject warn+delete lane.
    if body.get("hello").and_then(serde_json::Value::as_bool) == Some(true) {
        return Some(ParsedSignal::Hello {
            terminal_id: terminal_id.to_string(),
        });
    }
    let session_id = body.get("session_id")?.as_str()?;
    if !is_valid_opencode_session_id(session_id) {
        return None;
    }
    Some(ParsedSignal::Rebind(OpencodeSignal {
        path: path.to_path_buf(),
        terminal_id: terminal_id.to_string(),
        session_id: session_id.to_string(),
        source: body
            .get("source")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }))
}

/// How long an opencode pane may run without the rebind plugin's startup
/// hello before the heartbeat alarm fires once. 120s (the generous end of
/// the 60-120s design range): opencode TUI cold start + Bun plugin load +
/// one 1s sweep tick, with slack for loaded CI machines. Pinned by
/// `hello_grace_stays_generous`.
pub(crate) const OPENCODE_HELLO_GRACE_MS: i64 = 120_000;

/// Injection skips the server CAN see at warn time, re-derived from its own
/// process env with zero plumbing: the FRESHELL_OPENCODE_REBIND kill switch
/// and a user-set OPENCODE_TUI_CONFIG. Per-pane env overrides and opencode's
/// `--pure` are NOT visible here -- the WARN text names them and stays
/// advisory for those.
fn opencode_injection_disabled_by_env() -> bool {
    let kill_switch = matches!(
        std::env::var("FRESHELL_OPENCODE_REBIND").ok().as_deref(),
        Some("0") | Some("false")
    );
    kill_switch || std::env::var("OPENCODE_TUI_CONFIG").is_ok()
}

/// One heartbeat pass (invariants.rs `warn_unresolved_terminal_identities`
/// pattern: pure fn, injected now_ms, once-per-terminal HashSet bound):
/// WARN for every RUNNING opencode pane older than
/// [`OPENCODE_HELLO_GRACE_MS`] whose terminalId never said hello.
pub(crate) fn warn_opencode_panes_without_hello(
    rows: &[IdentityProbeRow],
    tracker: &mut HelloTracker,
    injection_disabled: bool,
    now_ms: i64,
) {
    if injection_disabled {
        return;
    }
    for row in rows {
        if row.mode != "opencode"
            || row.status != TerminalRunStatus::Running
            || tracker.seen.contains(&row.terminal_id)
            || tracker.warned.contains(&row.terminal_id)
        {
            continue;
        }
        let age_ms = now_ms - row.created_at;
        if age_ms <= OPENCODE_HELLO_GRACE_MS {
            continue;
        }
        tracker.warned.insert(row.terminal_id.clone());
        tracing::warn!(
            terminal_id = %row.terminal_id,
            age_ms = age_ms,
            "opencode_rebind_heartbeat_missing: opencode pane has run past the \
             hello grace window without a plugin-alive signal -- mid-session \
             rebind is likely degraded (plugin not loaded / opencode plugin \
             API drift / plugins disabled via --pure or a per-pane config). \
             Advisory: per-pane injection skips are not visible to this check."
        );
    }
}

/// Drain opencode switch signals and rebind panes through the guarded lane.
/// `pub` so integration tests drive drains deterministically.
///
/// Guard ladder (drain_and_rebind_claude's ladder + the D1 extensions from
/// the 2026-07-28 validation pass; the producer is per-terminal by
/// construction — the plugin reads FRESHELL_TERMINAL_ID from its own PTY
/// env — so codex's D7 old-owner predicate is subsumed by the live-pane +
/// provider-match check, exactly as in the claude lane):
///   (0)  identity row present with provider opencode, PLUS two extensions:
///   (0a) FIRST-BIND ARBITRATION (D1.2, also resolves the locator race):
///        no identity row, but the registry shows a LIVE never-bound
///        opencode pane (mode=="opencode", Running,
///        resume_session_id.is_none()) ⇒ first bind through guards (2)-(4),
///        cwd from the registry entry, previousSessionId None. The signal
///        is user-facing route truth and outranks the locator's DB
///        heuristic; the bind itself disarms the locator
///        (opencode_association.rs:127 rejects once
///        resume_session_id.is_some()). No pane at all ⇒ RETAIN the file.
///   (0b) RETIRED-PANE REBIND (D1.3): identity row RETIRED with provider
///        opencode and a different session id ⇒ run guards (2)-(4), then
///        identity.upsert + immediate re-retire (upsert clears the retired
///        flag; retire preserves fields), SKIP registry.set_meta (no live
///        row), await ledger_resolve_identity (G3 supersede), broadcast
///        `associated` with previousSessionId — the frozen client applies
///        association by layout presence, not liveness
///        (src/lib/terminal-session-association.ts:84-105), so the
///        persisted pane ref moves and a future restore resumes the NEW id.
///   (1) same-id no-op (the plugin dedupes, but the initial route poll
///   re-reports the bound id at startup), (2) A13 no live owner of the
///   target, (3) ledger A8 retired-inclusive, (4) fresh-agent sessions
///   never bind terminal panes.
/// ACT-THEN-DELETE (D1.1): sig.path is removed only after the signal was
/// acted on (rebound, same-id no-op, or a deliberate guard refusal) or
/// discarded as permanently unactionable (foreign-provider pane); files
/// with no actionable pane YET are RETAINED for later sweeps (the watcher's
/// staleness cap reaps abandoned ones).
/// NEVER any activity/row-correlation fallback: no signal ⇒ no rebind.
pub async fn drain_and_rebind_opencode(state: &WsState, watcher: &OpencodeSignalWatcher) {
    // drain() is sync fs I/O -> blocking pool (claude_signal.rs pattern).
    let drain_watcher = watcher.clone();
    let outcome = match tokio::task::spawn_blocking(move || drain_watcher.drain()).await {
        Ok(outcome) => outcome,
        Err(join_error) => {
            tracing::warn!(
                error = %join_error,
                "opencode_signal_drain_panicked: blocking drain task panicked, skipping this cycle"
            );
            return;
        }
    };
    // Plugin-alive heartbeat pass: fold consumed hellos into the tracker,
    // then WARN once per RUNNING opencode pane that outlived the grace
    // window without ever saying hello (suppressed when the server's own
    // env shows injection was deliberately skipped).
    {
        let mut tracker = watcher.hello.lock().expect("hello tracker poisoned");
        tracker.seen.extend(outcome.hellos.iter().cloned());
        let injection_disabled = opencode_injection_disabled_by_env();
        warn_opencode_panes_without_hello(
            &state.registry.identity_probe_rows(),
            &mut tracker,
            injection_disabled,
            crate::terminal::now_ms(),
        );
    }
    for sig in outcome.rebinds {
        match apply_opencode_signal(state, &sig).await {
            SignalDisposition::Acted | SignalDisposition::Discard => {
                let _ = std::fs::remove_file(&sig.path); // act/discard-then-delete (D1.1)
            }
            // Not actionable YET => the file stays for a later sweep.
            SignalDisposition::Retain => {}
        }
    }
}

/// Guards (2)-(4): A13 live-owner, ledger A8 retired-inclusive, fresh-agent.
/// `false` (warn-logged where meaningful) = the target session must NOT be
/// bound to this terminal — a deliberate refusal, which still counts as
/// ACTED ON for act-then-delete purposes.
fn target_session_guards_pass(state: &WsState, sig: &OpencodeSignal) -> bool {
    if let Some(owner) =
        state
            .registry
            .live_session_owner(Some(&state.identity), "opencode", &sig.session_id)
    {
        tracing::warn!(terminal_id = %sig.terminal_id, owner = %owner,
            "opencode_rebind_refused: target session already live-owned (A13)");
        return false;
    }
    if let Some(existing) = state
        .identity
        .find_by_session_including_retired("opencode", &sig.session_id)
    {
        if existing != sig.terminal_id {
            tracing::warn!(terminal_id = %sig.terminal_id,
                "opencode_rebind_refused: session_bound_elsewhere");
            return false;
        }
    }
    if state
        .pane_ledger
        .lookup_by_session("opencode", &sig.session_id)
        .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
    {
        return false;
    }
    true
}

/// PINNED fan-out for live panes: identity -> meta -> ledger(await) ->
/// associated THEN meta.updated.
async fn rebind_fanout(
    state: &WsState,
    sig: &OpencodeSignal,
    cwd: Option<&str>,
    previous: Option<String>,
) {
    state.identity.upsert(
        &sig.terminal_id,
        Some("opencode"),
        Some(&sig.session_id),
        cwd,
        now_ms(),
    );
    state.registry.set_meta(
        &sig.terminal_id,
        None,
        None,
        Some("opencode".to_string()),
        Some(sig.session_id.clone()),
    );
    crate::pane_ledger::ledger_resolve_identity(
        state,
        &sig.terminal_id,
        "opencode",
        &sig.session_id,
        cwd,
    )
    .await;
    crate::codex_identity::broadcast_terminal_session_associated(
        state,
        "opencode",
        &sig.terminal_id,
        &sig.session_id,
        cwd.map(str::to_string),
        previous,
    );
    // Task 10: feed the identity proof into the activity hub — the in-TUI
    // session-switch (and first-bind) signal rebinds the tracker's owned
    // root; deferred (awaitingAssociation) completions release on this bind
    // (channel-deferred, safe off the sweep task; codex_identity.rs:221
    // precedent).
    if let Some(hub) = &state.activity {
        hub.bind_opencode_session(&sig.terminal_id, &sig.session_id);
    }
}

/// Outcome of applying one signal: `Acted` (rebind done), `Retain` (might
/// become actionable later -- keep the file for the next sweep), `Discard`
/// (permanently unactionable -- consume the file so it neither accumulates
/// nor re-logs; deleting a signal degrades only to no-rebind, per the
/// module's degradation policy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalDisposition {
    Acted,
    Retain,
    Discard,
}

/// One signal through the ladder. Returns the file's disposition: `Acted`
/// and `Discard` delete the file; `Retain` keeps it for a later sweep.
async fn apply_opencode_signal(state: &WsState, sig: &OpencodeSignal) -> SignalDisposition {
    let Some(current) = state.identity.get(&sig.terminal_id) else {
        // (0a) D1.2 first-bind arbitration — the registry's per-terminal
        // identity probe carries exactly the fields the arbitration needs
        // (mode / status / resume_session_id / cwd).
        let Some(entry) = state.registry.probe(&sig.terminal_id) else {
            return SignalDisposition::Retain; // no pane (yet): RETAIN for a later sweep
        };
        if entry.mode != "opencode" {
            // Foreign-provider pane (registry row): a pane's mode never
            // changes, so this signal can never become actionable. Explicit
            // ignore-with-log + consume (A8 detectability, bounded noise).
            tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
                mode = %entry.mode, source = ?sig.source,
                "opencode_signal_ignored: pane belongs to another provider, consuming file");
            return SignalDisposition::Discard;
        }
        if entry.status != freshell_protocol::TerminalRunStatus::Running
            || entry.resume_session_id.is_some()
        {
            return SignalDisposition::Retain; // not a live never-bound opencode pane
        }
        if !target_session_guards_pass(state, sig) {
            return SignalDisposition::Acted; // deliberate refusal — acted
        }
        tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
            source = ?sig.source,
            "opencode_rebind: first bind via TUI signal (signal outranks locator)");
        rebind_fanout(state, sig, entry.cwd.as_deref(), None).await;
        return SignalDisposition::Acted;
    };

    if current.provider.as_deref() != Some("opencode") {
        // Foreign-provider identity row: never touch the pane (one-writer /
        // D7) -- and never actionable (a pane's provider does not change),
        // so consume instead of silently re-reading it every sweep.
        tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            provider = ?current.provider, source = ?sig.source,
            "opencode_signal_ignored: identity row belongs to another provider, consuming file");
        return SignalDisposition::Discard;
    }
    if current.session_id.as_deref() == Some(sig.session_id.as_str()) {
        return SignalDisposition::Acted; // same-id no-op — acted
    }
    if !target_session_guards_pass(state, sig) {
        return SignalDisposition::Acted; // A13 / ledger A8 / fresh-agent refusal — acted
    }

    let previous = current.session_id.clone();
    if current.retired {
        // (0b) D1.3 retired-pane rebind: the pane died after the switch but
        // the signal survived (retention). Move the persisted ref so a
        // future restore resumes the NEW id.
        tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
            source = ?sig.source, "opencode_rebind: retired pane ref moved to new session");
        state.identity.upsert(
            &sig.terminal_id,
            Some("opencode"),
            Some(&sig.session_id),
            current.cwd.as_deref(),
            now_ms(),
        );
        // upsert cleared the retired flag; re-retire preserves fields.
        state.identity.retire(&sig.terminal_id);
        // SKIP registry.set_meta: no live row.
        crate::pane_ledger::ledger_resolve_identity(
            state,
            &sig.terminal_id,
            "opencode",
            &sig.session_id,
            current.cwd.as_deref(),
        )
        .await;
        crate::codex_identity::broadcast_terminal_session_associated(
            state,
            "opencode",
            &sig.terminal_id,
            &sig.session_id,
            current.cwd.clone(),
            previous,
        );
        return SignalDisposition::Acted;
    }

    // (0) live pane — the ordinary rebind path.
    tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
        source = ?sig.source, "opencode_rebind: TUI plugin reported a new session id");
    rebind_fanout(state, sig, current.cwd.as_deref(), previous).await;
    SignalDisposition::Acted
}

/// Sweep cadence — mirrors CLAUDE_SIGNAL_SWEEP_INTERVAL (claude_signal.rs:24):
/// signal files are rare (one per in-TUI switch) so 1s is comfortably fresh
/// and comfortably cheap. Introduced here (not in Task 4) because this is its
/// only consumer — an unused private const would fail Task 4's
/// `clippy -D warnings` gate.
const OPENCODE_SIGNAL_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Spawned by `freshell-server` boot next to the sibling sweeps (mirrors
/// `spawn_claude_signal_sweep`'s task shape): periodically drain the signal
/// root and process any rebinds, off the per-connection select loops.
pub fn spawn_opencode_signal_sweep(state: WsState, watcher: OpencodeSignalWatcher) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(OPENCODE_SIGNAL_SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            drain_and_rebind_opencode(&state, &watcher).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_signal(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn session_id_shape_is_enforced() {
        assert!(is_valid_opencode_session_id("ses_abc123XYZ"));
        assert!(!is_valid_opencode_session_id("ses_"));
        assert!(!is_valid_opencode_session_id("ses_ab-cd"));
        assert!(!is_valid_opencode_session_id(
            "22222222-3333-4444-8555-666677778888"
        ));
        assert!(!is_valid_opencode_session_id(""));
    }

    fn remaining(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn drain_parses_sorts_retains_valid_files_and_consumes_rejects() {
        let dir = tempfile::tempdir().unwrap();
        // Timestamp-first nonces: lexicographic order == emission order.
        write_signal(
            dir.path(),
            "term-1__00000000000002-000002-9.json",
            r#"{"session_id":"ses_bbb","source":"opencode-tui-plugin"}"#,
        );
        write_signal(
            dir.path(),
            "term-1__00000000000001-000001-9.json",
            r#"{"session_id":"ses_aaa","source":"opencode-tui-plugin"}"#,
        );
        // Rejected (warn-logged as opencode_signal_rejected + deleted):
        // bad id shape (claude-style uuid), malformed json, missing __.
        write_signal(
            dir.path(),
            "term-1__00000000000003-000003-9.json",
            r#"{"session_id":"22222222-3333-4444-8555-666677778888"}"#,
        );
        write_signal(dir.path(), "junk__1.json", "{not json");
        write_signal(dir.path(), "no-delimiter.json", r#"{"session_id":"ses_x"}"#);
        // Ignored entirely (staging file), must survive the drain.
        write_signal(
            dir.path(),
            "term-1__00000000000004-000004-9.tmp",
            r#"{"session_id":"ses_ccc"}"#,
        );

        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let outcome = watcher.drain();
        let ids: Vec<(&str, &str)> = outcome
            .rebinds
            .iter()
            .map(|s| (s.terminal_id.as_str(), s.session_id.as_str()))
            .collect();
        assert_eq!(ids, vec![("term-1", "ses_aaa"), ("term-1", "ses_bbb")]);
        assert_eq!(
            outcome.rebinds[0].source.as_deref(),
            Some("opencode-tui-plugin")
        );
        // Valid signals carry their file paths and are RETAINED on disk —
        // the Task 5 consumer deletes each file only after ACTING on it
        // (act-then-delete, D1.1).
        assert!(outcome.rebinds.iter().all(|s| s.path.exists()));
        // Rejected .json files are consumed (single-shot — junk must not
        // re-fail every sweep); the .tmp staging file is untouched.
        assert_eq!(
            remaining(dir.path()),
            vec![
                "term-1__00000000000001-000001-9.json".to_string(),
                "term-1__00000000000002-000002-9.json".to_string(),
                "term-1__00000000000004-000004-9.tmp".to_string(),
            ]
        );
    }

    #[test]
    fn drain_consumes_hello_files_and_reports_their_terminal_ids() {
        let dir = tempfile::tempdir().unwrap();
        write_signal(
            dir.path(),
            "term-h__00000000000001-000000-1.json",
            r#"{"hello":true,"source":"opencode-tui-plugin"}"#,
        );
        write_signal(
            dir.path(),
            "term-h__00000000000002-000001-1.json",
            r#"{"session_id":"ses_aaa","source":"opencode-tui-plugin"}"#,
        );
        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let outcome = watcher.drain();
        assert_eq!(outcome.hellos, vec!["term-h".to_string()]);
        assert_eq!(outcome.rebinds.len(), 1);
        assert_eq!(outcome.rebinds[0].session_id, "ses_aaa");
        // Hello is delete-on-read; the rebind file is retained
        // (act-then-delete happens in the consumer, not the drain).
        assert_eq!(
            remaining(dir.path()),
            vec!["term-h__00000000000002-000001-1.json".to_string()]
        );
    }

    #[test]
    fn hello_files_never_hit_the_reject_warn_lane() {
        let (events, _guard) = crate::invariants::capture::capture();
        let dir = tempfile::tempdir().unwrap();
        write_signal(
            dir.path(),
            "term-h__00000000000001-000000-1.json",
            r#"{"hello":true}"#,
        );
        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let outcome = watcher.drain();
        assert_eq!(outcome.hellos, vec!["term-h".to_string()]);
        let events = events.lock().unwrap();
        assert!(
            !events
                .iter()
                .any(|e| e.message.contains("opencode_signal_rejected")),
            "a hello must not be warn-logged as a reject"
        );
    }

    #[test]
    fn drain_reaps_stale_files_without_emitting() {
        let dir = tempfile::tempdir().unwrap();
        write_signal(
            dir.path(),
            "term-1__00000000000001-000001-9.json",
            r#"{"session_id":"ses_old"}"#,
        );
        let path = dir.path().join("term-1__00000000000001-000001-9.json");
        // Backdate past the retention cap (D1.1 staleness reap).
        let stale = std::time::SystemTime::now()
            - STALE_SIGNAL_MAX_AGE
            - std::time::Duration::from_secs(60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stale)
            .unwrap();
        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let outcome = watcher.drain();
        assert!(outcome.rebinds.is_empty());
        assert!(outcome.hellos.is_empty());
        assert!(!path.exists());
    }

    fn probe_row(terminal_id: &str, mode: &str, created_at: i64) -> IdentityProbeRow {
        IdentityProbeRow {
            terminal_id: terminal_id.to_string(),
            mode: mode.to_string(),
            status: TerminalRunStatus::Running,
            created_at,
            resume_session_id: None,
            cwd: None,
        }
    }

    #[test]
    fn warns_once_for_an_opencode_pane_past_grace_with_no_hello() {
        let (events, _guard) = crate::invariants::capture::capture();
        let mut tracker = HelloTracker::default();
        let rows = vec![probe_row("term-1", "opencode", 0)];
        let now = OPENCODE_HELLO_GRACE_MS + 1;
        warn_opencode_panes_without_hello(&rows, &mut tracker, false, now);
        warn_opencode_panes_without_hello(&rows, &mut tracker, false, now + 10_000);
        let events = events.lock().unwrap();
        let warns: Vec<_> = events
            .iter()
            .filter(|e| e.message.contains("opencode_rebind_heartbeat_missing"))
            .collect();
        assert_eq!(warns.len(), 1, "once per terminal, ever: {warns:?}");
    }

    #[test]
    fn no_warn_when_hello_seen_young_non_opencode_or_injection_disabled() {
        let (events, _guard) = crate::invariants::capture::capture();
        let now = OPENCODE_HELLO_GRACE_MS + 1;

        // hello seen
        let mut tracker = HelloTracker::default();
        tracker.seen.insert("term-1".to_string());
        warn_opencode_panes_without_hello(
            &[probe_row("term-1", "opencode", 0)],
            &mut tracker,
            false,
            now,
        );

        // young pane (inside grace)
        let mut tracker = HelloTracker::default();
        warn_opencode_panes_without_hello(
            &[probe_row("term-2", "opencode", now - 1_000)],
            &mut tracker,
            false,
            now,
        );

        // non-opencode pane
        let mut tracker = HelloTracker::default();
        warn_opencode_panes_without_hello(
            &[probe_row("term-3", "codex", 0)],
            &mut tracker,
            false,
            now,
        );

        // injection deliberately skipped (kill switch / user OPENCODE_TUI_CONFIG)
        let mut tracker = HelloTracker::default();
        warn_opencode_panes_without_hello(
            &[probe_row("term-4", "opencode", 0)],
            &mut tracker,
            true,
            now,
        );

        let events = events.lock().unwrap();
        assert!(
            !events
                .iter()
                .any(|e| e.message.contains("opencode_rebind_heartbeat_missing")),
            "no warn in any suppressed case"
        );
    }

    #[test]
    fn hello_grace_stays_generous() {
        // TUI cold start + Bun plugin load + one 1s sweep tick, with slack.
        assert_eq!(OPENCODE_HELLO_GRACE_MS, 120_000);
    }

    #[test]
    fn drain_reaps_stale_tmp_staging_files_but_keeps_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        write_signal(
            &root,
            "t1__00000000000001-000001-1.json",
            r#"{"session_id":"ses_abc123"}"#,
        );
        write_signal(&root, "t1__00000000000002-000001-1.tmp", "in-flight");
        write_signal(&root, "t1__00000000000003-000001-1.tmp", "orphaned");
        let stale = std::time::SystemTime::now()
            - STALE_SIGNAL_MAX_AGE
            - std::time::Duration::from_secs(60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(root.join("t1__00000000000003-000001-1.tmp"))
            .unwrap()
            .set_modified(stale)
            .unwrap();
        let watcher = OpencodeSignalWatcher::new(root.clone());
        let outcome = watcher.drain();
        assert_eq!(outcome.rebinds.len(), 1, "the valid json still parses");
        assert_eq!(
            remaining(&root),
            vec![
                "t1__00000000000001-000001-1.json".to_string(), // retained: act-then-delete
                "t1__00000000000002-000001-1.tmp".to_string(),  // fresh staging: untouched
            ],
            "the orphaned stale .tmp must be reaped"
        );
    }

    #[test]
    fn drain_on_missing_directory_is_empty() {
        let watcher = OpencodeSignalWatcher::new(std::path::PathBuf::from(
            "/nonexistent/freshell-opencode-signals",
        ));
        let outcome = watcher.drain();
        assert!(outcome.rebinds.is_empty());
        assert!(outcome.hellos.is_empty());
    }
}
