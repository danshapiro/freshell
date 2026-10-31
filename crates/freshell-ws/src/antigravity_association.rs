//! Antigravity terminal-pane association controller (antigravity plan
//! Task 6): the hub-held capture + sweep that turns the
//! `freshell_sessions::antigravity_locator`'s unified
//! first-bind/rebind evidence into real identity homes.
//!
//! Structure mirrors `codex_association.rs` (arm-at-create, submit feed,
//! a polling sweep driving the locator's tick, adoption through a shared
//! tail) with the antigravity plan's two deliberate deltas:
//!
//! - The submit-text capture consumes `ActivityEvent::Input` bytes — the
//!   same input stream the activity hub already routes per-terminal —
//!   NOT a codex `note_submit` reuse: the codex precedent snapshots file
//!   paths with no prompt-text buffer, while terminal input arrives as
//!   byte chunks with Enter commonly alone. The association keeps a
//!   per-pane line buffer, flushed at the Enter byte, and the flushed
//!   line is what the locator matches against each transcript's LATEST
//!   user-authored record.
//!
//!   // Stage-1 candidate contract (submit-key byte discipline, modeled
//!   // on `freshell-activity/signal.rs`'s `classify_input` CR/LF
//!   // rule — typed submit bytes vs content bytes are distinguished at
//!   // the byte level, and the distinction is DOCUMENTED, not guessed):
//!   // the terminal sends CR (0x0D) for the Enter key — CR flushes the
//!   // buffer as ONE submit. LF (0x0A) is Ctrl+J, which the Antigravity
//!   // CLI documents as "insert a newline into the prompt"
//!   // (antigravity.google/docs/cli/reference/) — LF JOINS the current
//!   // buffer as inline newline content, never a submit, so a
//!   // multi-line prompt flushes as the FULL multi-line payload and can
//!   // bind the transcript user record carrying both lines
//!   // (whole-delta review Major 2). Pasted text arrives CR-separated
//!   // (xterm.js `prepareTextForTerminal` converts pasted `\r?\n` to
//!   // `\r` before the bytes reach the PTY), so a pasted multi-line blob
//!   // still flushes per line and its LAST line is the live capture —
//!   // `classify_input`'s "the LAST pasted line remains evaluable"
//!   // stance; a paste-frame-aware capture is deferred until a real
//!   // binary proves the recorded form of a pasted blob (the A2
//!   // blocker). The newline byte the CLI writes INSIDE its recorded
//!   // multi-line user text is likewise fixture-validated only.
//!
//! - The association lives ON the hub (a `HubInner` slot, set once at
//!   boot) rather than a `WsState` field: its whole input feed IS the
//!   hub's event stream, so its lifetime is bounded by the hub's, and a
//!   `WsState` field would have churned every hand-built test `WsState`
//!   literal in the tree. The sweep reads it back through
//!   `state.activity` exactly like the codex rollout locator does.
//!
//! The adoption/rebind tail is a thin antigravity-specific tail that
//! CALLS the same helpers the codex tail uses (ledger-first
//! `ledger_resolve_identity`, `identity.upsert`, `bind_pending_naming`,
//! `follow_identity_switch`, `registry.set_meta`, the ONE shared
//! provider-parameterized `broadcast_terminal_session_associated`, and
//! the coordinator begin/commit pair) — the guard ladder is restated
//! per provider because the codex claim guard's fresh-agent arms have no
//! antigravity analogue (no fresh-agent antigravity lane exists).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use freshell_protocol::TerminalRunStatus;
use freshell_sessions::antigravity_locator::AntigravityLocated;

use crate::terminal::now_ms;
use crate::WsState;

/// Per-pane line capture: the raw input bytes since the last Enter, plus
/// the submit lines flushed at Enter bytes (drained by the sweep).
#[derive(Debug, Default)]
struct PaneCapture {
    buffer: String,
    submits: VecDeque<(String, i64)>,
}

/// Line-buffer cap: a single prompt line is bounded; past this the extra
/// bytes are dropped (they could never match a bounded comparison anyway).
const MAX_LINE_BUFFER_CHARS: usize = 16 * 1024;

/// The hub-held association: the locator plus the per-pane input capture.
pub struct AntigravityAssociation {
    /// The RESOLVED antigravity home (the `antigravity-cli` subtree) —
    /// the naming acquisition's `NativeLocation::Antigravity.home` and
    /// the base of the locator's brain root.
    antigravity_home: PathBuf,
    locator: freshell_sessions::antigravity_locator::AntigravityLocator,
    panes: Mutex<HashMap<String, PaneCapture>>,
}

impl AntigravityAssociation {
    /// `antigravity_home` is the RESOLVED home (the `antigravity-cli`
    /// subtree — `freshell_sessions::provider_layout::antigravity_home`);
    /// the locator root is its `brain/` tree (`AntigravityLayout`).
    pub fn new(antigravity_home: PathBuf) -> Self {
        use freshell_sessions::provider_layout::{AntigravityLayout, ProviderLayout};
        let root = AntigravityLayout.session_root(&antigravity_home);
        Self {
            antigravity_home,
            locator: freshell_sessions::antigravity_locator::AntigravityLocator::new(root),
            panes: Mutex::new(HashMap::new()),
        }
    }

    pub fn antigravity_home(&self) -> &std::path::Path {
        &self.antigravity_home
    }

    pub fn locator(&self) -> &freshell_sessions::antigravity_locator::AntigravityLocator {
        &self.locator
    }

    /// Hub-side `ActivityEvent::Created` intake: tag the pane so input
    /// bytes start buffering from its very first keystroke (the sweep
    /// completes the arm with the registry's cwd — the Created event
    /// carries none).
    pub fn note_created(&self, terminal_id: &str, mode: &str) {
        if mode != "antigravity" || terminal_id.is_empty() {
            return;
        }
        let mut panes = self.panes.lock().unwrap();
        panes.entry(terminal_id.to_string()).or_default();
    }

    /// Hub-side `ActivityEvent::Input` intake: fold one input chunk into
    /// the pane's line buffer, flushing ONLY at the Enter byte (CR), and
    /// report the pane's tag state in the same lock scope. Returns
    /// `(flushed, tagged)`: `flushed` = whether this chunk flushed at
    /// least one non-empty submit line (the hub uses that to arm the
    /// idle gate's provisional busy phase — the crash death-bell
    /// engagement); `tagged` = whether the hub has this pane tagged
    /// (the hub's #612 quit-intent gate for antigravity panes, which are
    /// not tracker-modes until Task 8 — a deliberate user quit must
    /// suppress that death bell too, so the classification needs to see
    /// every input byte of a tagged pane).
    ///
    /// Byte discipline (the Stage-1 candidate contract documented in the
    /// module header): CR (Enter) flushes the FULL buffer — including
    /// any inline newlines Ctrl+J joined into it — as one submit; LF
    /// (Ctrl+J, "insert newline into the prompt") JOINS the current
    /// buffer as content and never flushes; DEL (0x7f) and BS (0x08) pop
    /// the last buffered char (the CLI's recorded text reflects the line
    /// editor's deletions, so the capture must too); ESC-prefixed
    /// sequences (arrow keys etc.) are dropped whole; other C0 controls
    /// except TAB are dropped; the rest append.
    pub fn note_input_tagged(&self, terminal_id: &str, data: &str, at_ms: i64) -> (bool, bool) {
        let mut panes = self.panes.lock().unwrap();
        let Some(pane) = panes.get_mut(terminal_id) else {
            return (false, false);
        };
        let mut flushed = false;
        #[derive(PartialEq)]
        enum Esc {
            None,
            Intro,
            Sequence,
        }
        let mut esc = Esc::None;
        for ch in data.chars() {
            match esc {
                Esc::Intro => {
                    // The byte after ESC: '[' or 'O' starts a sequence
                    // (CSI/SS3); anything else was a two-byte escape.
                    esc = if ch == '[' || ch == 'O' {
                        Esc::Sequence
                    } else {
                        Esc::None
                    };
                    continue;
                }
                Esc::Sequence => {
                    // Consume the sequence through its final byte
                    // (0x40..=0x7E for CSI; SS3 finals share the range).
                    if ('\u{40}'..='\u{7e}').contains(&ch) {
                        esc = Esc::None;
                    }
                    continue;
                }
                Esc::None => {}
            }
            match ch {
                '\r' => {
                    // Enter: flush the FULL buffer (multi-line payloads
                    // included) as one submit.
                    let line = std::mem::take(&mut pane.buffer);
                    if !line.trim().is_empty() {
                        pane.submits.push_back((line, at_ms));
                        flushed = true;
                    }
                }
                '\n' => {
                    // Ctrl+J ("insert a newline into the prompt" — the
                    // CLI's documented multiline form): inline content,
                    // never a submit.
                    if pane.buffer.chars().count() < MAX_LINE_BUFFER_CHARS {
                        pane.buffer.push('\n');
                    }
                }
                '\u{7f}' | '\u{8}' => {
                    pane.buffer.pop();
                }
                '\u{1b}' => {
                    esc = Esc::Intro;
                }
                '\t' => {
                    if pane.buffer.chars().count() < MAX_LINE_BUFFER_CHARS {
                        pane.buffer.push(ch);
                    }
                }
                c if (c as u32) < 0x20 => {}
                c => {
                    if pane.buffer.chars().count() < MAX_LINE_BUFFER_CHARS {
                        pane.buffer.push(c);
                    }
                }
            }
        }
        (flushed, true)
    }

    /// The `flushed` half of [`Self::note_input_tagged`] (the capture
    /// tests' projection): whether this chunk flushed at least one
    /// non-empty submit line.
    pub fn note_input(&self, terminal_id: &str, data: &str, at_ms: i64) -> bool {
        self.note_input_tagged(terminal_id, data, at_ms).0
    }

    /// Hub-side `ActivityEvent::Exit` intake: drop the pane's capture and
    /// its locator arm. Returns whether the pane was known (the hub also
    /// drops the pane's idle-gate state then — antigravity panes are not
    /// tracker-modes, so the modes-map teardown never runs for them).
    pub fn note_exit(&self, terminal_id: &str) -> bool {
        self.locator.disarm(terminal_id);
        self.panes.lock().unwrap().remove(terminal_id).is_some()
    }

    /// The sweep's arm step: arm a mode-tagged pane with its registry cwd
    /// (idempotent; the locator gates empty cwds and re-arms).
    pub fn arm(&self, terminal_id: &str, cwd: &str) -> bool {
        self.locator.arm(terminal_id, cwd)
    }

    /// The pane ids the hub has tagged (the sweep joins these against the
    /// registry directory for cwd/managed/running truth).
    pub fn pane_ids(&self) -> Vec<String> {
        self.panes.lock().unwrap().keys().cloned().collect()
    }

    /// Drain the captured submit lines (the sweep feeds each into the
    /// locator; un-armed panes are refused there).
    pub fn take_pending_submits(&self) -> Vec<(String, String, i64)> {
        let mut panes = self.panes.lock().unwrap();
        let mut out = Vec::new();
        for (tid, pane) in panes.iter_mut() {
            for (text, at) in pane.submits.drain(..) {
                out.push((tid.clone(), text, at));
            }
        }
        out
    }

    /// The sweep's discard step (mode mismatch): the pane is no longer an
    /// antigravity pane — drop its capture and locator arm so it can
    /// never match again.
    pub fn discard(&self, terminal_id: &str) {
        self.locator.disarm(terminal_id);
        self.panes.lock().unwrap().remove(terminal_id);
    }

    /// One locator tick on the blocking pool (the tick walks the brain
    /// tree and probes candidate transcripts — never on an async worker).
    /// Takes `Arc<Self>` because `spawn_blocking` requires 'static.
    pub async fn tick(self: &Arc<Self>, now: i64) -> Vec<AntigravityLocated> {
        let association = Arc::clone(self);
        match tokio::task::spawn_blocking(move || association.locator.tick(now)).await {
            Ok(located) => located,
            Err(join_error) => {
                tracing::warn!(
                    error = %join_error,
                    "antigravity_locator_tick_panicked: sweep tick task panicked, skipping this cycle"
                );
                Vec::new()
            }
        }
    }
}

/// Drive one sweep cycle: arm mode-tagged panes from registry truth, feed
/// the captured submit lines into the locator, tick it on the blocking
/// pool, and process every located match through the guard ladder + the
/// adoption/rebind tail.
pub async fn drain_and_associate(state: &WsState) {
    let Some(hub) = &state.activity else {
        return;
    };
    let association = match hub.antigravity_association() {
        Some(association) => association,
        None => return,
    };

    // Arm step: registry truth (mode/managed/running/cwd) for panes the
    // hub tagged at Created. Cheap (a small directory snapshot + an
    // idempotent arm) and runs at most once per pane per server lifetime.
    let pane_ids: HashSet<String> = association.pane_ids().into_iter().collect();
    if !pane_ids.is_empty() {
        for entry in state.registry.directory() {
            if !pane_ids.contains(&entry.terminal_id) {
                continue;
            }
            if entry.mode != "antigravity" || entry.status != TerminalRunStatus::Running {
                continue;
            }
            if state.registry.is_managed(&entry.terminal_id) {
                continue;
            }
            if let Some(cwd) = entry.cwd.clone().filter(|c| !c.is_empty()) {
                association.arm(&entry.terminal_id, &cwd);
            }
        }
    }

    // Submit feed: the captured lines anchor the locator's windows at
    // their Enter timestamps. Pure state, no fs.
    for (terminal_id, text, at) in association.take_pending_submits() {
        association.locator().note_submit(&terminal_id, &text, at);
    }

    let now = now_ms();
    let located = association.tick(now).await;
    for hit in located {
        // Defense-in-depth rejects against registry truth (the codex
        // drain's mirror): a terminal could legitimately vanish between
        // the tick and this drain.
        let Some(entry) = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == hit.terminal_id)
        else {
            tracing::warn!(
                target: "freshell_ws::antigravity_association",
                terminal_id = %hit.terminal_id,
                conversation_id = %hit.conversation_id,
                event = "antigravity_association_refused",
                reason = "unknown_terminal",
                "antigravity_association_refused: terminal_missing (pane state retained)"
            );
            continue;
        };
        if entry.mode != "antigravity" {
            tracing::warn!(
                target: "freshell_ws::antigravity_association",
                terminal_id = %hit.terminal_id,
                mode = %entry.mode,
                event = "antigravity_association_refused",
                reason = "mode_mismatch",
                "antigravity_association_refused: pane is not an antigravity pane (discarded)"
            );
            association.discard(&hit.terminal_id);
            continue;
        }
        if entry.status != TerminalRunStatus::Running {
            tracing::warn!(
                target: "freshell_ws::antigravity_association",
                terminal_id = %hit.terminal_id,
                event = "antigravity_association_refused",
                reason = "not_running",
                "antigravity_association_refused: pane is not running (pane state retained)"
            );
            continue;
        }
        // The unified rule's outcome split, decided against the identity
        // homes: same id -> no-op; different id -> first-bind (unbound) or
        // rebind (bound — the supersede moves through the shared tail's
        // guards).
        let current = state
            .identity
            .get(&hit.terminal_id)
            .filter(|row| row.provider.as_deref() == Some("antigravity"))
            .and_then(|row| row.session_id);
        match current {
            Some(current_id) if current_id == hit.conversation_id => {
                // No-op: the pane's own conversation continuing (the
                // locator stays armed for the switch forms). Task 8: the
                // attach is idempotent at the hub — it no-ops a lane
                // already tracking this conversation and RE-ATTACHES one
                // that has none (a resume/restart-created pane's first
                // submit lands here with identity already bound, so this
                // re-assert is the ONLY thing that ever binds its lane).
                if let Some(hub) = &state.activity {
                    hub.attach_antigravity_association(
                        &hit.terminal_id,
                        &hit.conversation_id,
                        &hit.transcript_path,
                        Some(hit.submit_at_ms),
                    );
                }
                tracing::debug!(
                    target: "freshell_ws::antigravity_association",
                    terminal_id = %hit.terminal_id,
                    conversation_id = %hit.conversation_id,
                    "antigravity_identity_noop: the matched conversation is the pane's current id"
                );
            }
            Some(old_id) => {
                let rebound = rebind_antigravity_identity(
                    state,
                    &hit.terminal_id,
                    &old_id,
                    &hit.conversation_id,
                    &hit.transcript_path,
                    entry.cwd.as_deref(),
                    hit.submit_at_ms,
                )
                .await;
                if !rebound {
                    tracing::warn!(
                        target: "freshell_ws::antigravity_association",
                        terminal_id = %hit.terminal_id,
                        conversation_id = %hit.conversation_id,
                        "antigravity_rebind_refused: the rebind tail's guards refused the move"
                    );
                }
            }
            None => {
                let adopted = adopt_antigravity_identity(
                    state,
                    &hit.terminal_id,
                    &hit.conversation_id,
                    &hit.transcript_path,
                    entry.cwd.as_deref(),
                    hit.submit_at_ms,
                )
                .await;
                if !adopted {
                    tracing::warn!(
                        target: "freshell_ws::antigravity_association",
                        terminal_id = %hit.terminal_id,
                        conversation_id = %hit.conversation_id,
                        "antigravity_adopt_refused: the adoption tail's guards refused the bind"
                    );
                }
            }
        }
    }
}

/// The sweep-timer wiring (mirrors `spawn_codex_locator_sweep`):
/// periodically drive the association's polling cycle off the
/// per-connection select loops.
pub fn spawn_antigravity_locator_sweep(state: WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            drain_and_associate(&state).await;
        }
    });
}

/// Shared hijack/misbind guards for BOTH adoption and rebind (the codex
/// claim guard's A13/A8 arms; the fresh-agent arms have no antigravity
/// analogue — no fresh-agent antigravity lane exists). `conversation_id`
/// is the id being CLAIMED. A same-terminal claim is an idempotent allow.
async fn antigravity_claim_refused(
    state: &WsState,
    terminal_id: &str,
    conversation_id: &str,
) -> bool {
    // A13: the target conversation must have no LIVE owner elsewhere.
    if let Some(owner) =
        state
            .registry
            .live_session_owner(Some(&state.identity), "antigravity", conversation_id)
    {
        if owner != terminal_id {
            tracing::warn!(
                target: "freshell_ws::antigravity_association",
                terminal_id = %terminal_id,
                conversation_id = %conversation_id,
                owner = %owner,
                event = "antigravity_association_refused",
                reason = "live_owner",
                "antigravity_association_refused: target conversation is live-owned elsewhere (A13)"
            );
            return true;
        }
    }
    // A8: not bound elsewhere RETIRED-INCLUSIVE (a dead pane's identity
    // must still repel adoption by a fresh terminal).
    if let Some(existing) = state
        .identity
        .find_by_session_including_retired("antigravity", conversation_id)
    {
        if existing != terminal_id {
            tracing::warn!(
                target: "freshell_ws::antigravity_association",
                terminal_id = %terminal_id,
                conversation_id = %conversation_id,
                existing = %existing,
                event = "antigravity_association_refused",
                reason = "bound_elsewhere",
                "antigravity_association_refused: conversation bound elsewhere, retired-inclusive (A8)"
            );
            return true;
        }
    }
    false
}

/// Bind a located conversation into every identity home, in the
/// load-bearing order (the codex tail's r14/r39 discipline: the authority
/// is acquired FIRST and held across the writes; a durable-binding
/// failure installs and announces NOTHING and the held authority
/// COMMITS — the live terminal stays the named owner, never a
/// Vacant-with-live-writer).
pub(crate) async fn adopt_antigravity_identity(
    state: &WsState,
    terminal_id: &str,
    conversation_id: &str,
    transcript_path: &std::path::Path,
    cwd: Option<&str>,
    submit_at_ms: i64,
) -> bool {
    if antigravity_claim_refused(state, terminal_id, conversation_id).await {
        return false;
    }
    let Some(authority) = crate::identity_ownership::coordinator_begin_identity(
        state,
        "antigravity",
        terminal_id,
        conversation_id,
        None,
    )
    .await
    else {
        return false;
    };
    let applied = apply_antigravity_identity(
        state,
        terminal_id,
        conversation_id,
        Some(transcript_path),
        cwd,
        None,
        submit_at_ms,
    )
    .await;
    if !applied {
        // r39 parity (codex_identity.rs:102-110): the durable binding
        // write failed with NOTHING installed or announced (the identity
        // homes keep the consistent prior state, no association frame
        // broadcast). The held authority COMMITS instead of failing —
        // the live terminal process IS the conversation's writer, so
        // failing the ticket to Vacant would let a later lifecycle
        // command start a SECOND writer beside it. The warn carries
        // codex's `committed_owner_kept` outcome marker so an operator
        // grepping incident logs for it finds antigravity incidents too.
        tracing::warn!(
            target: "freshell_ws::antigravity_association",
            terminal_id = %terminal_id,
            conversation_id = %conversation_id,
            event = "antigravity_identity.adoption_binding_failed",
            outcome = "committed_owner_kept",
            failure_reason = "DURABLE_BINDING_WRITE_FAILED",
            "antigravity_adopt_refused: the durable binding write failed — \
             nothing installed/announced; the held authority commits so the \
             live terminal stays the named owner (never a \
             Vacant-with-live-writer)"
        );
        crate::identity_ownership::coordinator_commit_identity(
            state,
            authority,
            "antigravity",
            terminal_id,
            conversation_id,
            None,
        )
        .await;
        return false;
    }
    crate::identity_ownership::coordinator_commit_identity(
        state,
        authority,
        "antigravity",
        terminal_id,
        conversation_id,
        None,
    )
    .await
}

/// Move a live pane's identity to a new conversation (the in-CLI switch
/// forms): the pane must be the LIVE owner of the superseded id (D7
/// predicate), and the new id must pass the shared claim guards (A13 +
/// A8). A refusal mutates nothing.
pub(crate) async fn rebind_antigravity_identity(
    state: &WsState,
    terminal_id: &str,
    old_conversation_id: &str,
    new_conversation_id: &str,
    transcript_path: &std::path::Path,
    cwd: Option<&str>,
    submit_at_ms: i64,
) -> bool {
    // Guard 1: the pane is the LIVE owner of the superseded id.
    if state
        .registry
        .live_session_owner(Some(&state.identity), "antigravity", old_conversation_id)
        .as_deref()
        != Some(terminal_id)
    {
        tracing::warn!(
            target: "freshell_ws::antigravity_association",
            terminal_id = %terminal_id,
            conversation_id = %old_conversation_id,
            event = "antigravity_association_refused",
            reason = "not_owner_of_superseded",
            "antigravity_association_refused: pane is not the live owner of the superseded conversation"
        );
        return false;
    }
    if antigravity_claim_refused(state, terminal_id, new_conversation_id).await {
        return false;
    }
    let Some(authority) = crate::identity_ownership::coordinator_begin_identity(
        state,
        "antigravity",
        terminal_id,
        new_conversation_id,
        Some(old_conversation_id),
    )
    .await
    else {
        return false;
    };
    tracing::info!(
        target: "freshell_ws::antigravity_association",
        terminal_id = %terminal_id,
        old_conversation_id = %old_conversation_id,
        new_conversation_id = %new_conversation_id,
        "antigravity_rebind: in-CLI switch detected; moving pane identity"
    );
    let applied = apply_antigravity_identity(
        state,
        terminal_id,
        new_conversation_id,
        Some(transcript_path),
        cwd,
        Some(old_conversation_id),
        submit_at_ms,
    )
    .await;
    if !applied {
        // r39 parity (codex_identity.rs:208-217 — the rebind twin of the
        // adopt tail's marker above): the durable binding write failed
        // with NOTHING installed or announced (the identity homes still
        // name the OLD conversation); the held authority COMMITS so the
        // live switched CLI stays the named writer (never a
        // Vacant-with-live-writer).
        tracing::warn!(
            target: "freshell_ws::antigravity_association",
            terminal_id = %terminal_id,
            old_conversation_id = %old_conversation_id,
            new_conversation_id = %new_conversation_id,
            event = "antigravity_identity.rebind_binding_failed",
            outcome = "committed_owner_kept",
            failure_reason = "DURABLE_BINDING_WRITE_FAILED",
            "antigravity_rebind_refused: the durable binding write failed — \
             nothing installed/announced; the held authority commits so the \
             live terminal stays the named owner (never a \
             Vacant-with-live-writer)"
        );
        crate::identity_ownership::coordinator_commit_identity(
            state,
            authority,
            "antigravity",
            terminal_id,
            new_conversation_id,
            Some(old_conversation_id),
        )
        .await;
        return false;
    }
    crate::identity_ownership::coordinator_commit_identity(
        state,
        authority,
        "antigravity",
        terminal_id,
        new_conversation_id,
        Some(old_conversation_id),
    )
    .await
}

/// The shared identity write tail (adoption AND rebind), in the PINNED
/// load-bearing order (the codex tail's exact discipline): durable ledger
/// FIRST (awaited, fsync-before-announce; a failure installs and
/// announces NOTHING) -> identity.upsert -> naming bind -> name-reliability
/// follow -> registry set_meta -> structured JSONL -> broadcast
/// `terminal.session.associated` (the ONE shared provider-parameterized
/// broadcaster) -> the activity hub's transcript-lane bind (plan Task 8:
/// the tracker bind + lane attach ride the same channel-deferred hub
/// event, carrying the located submit's `at` as the lane baseline's
/// boundary — whole-delta review round 2, Major 2) — then the caller's
/// coordinator commit.
async fn apply_antigravity_identity(
    state: &WsState,
    terminal_id: &str,
    conversation_id: &str,
    transcript_path: Option<&std::path::Path>,
    cwd: Option<&str>,
    previous_conversation_id: Option<&str>,
    submit_at_ms: i64,
) -> bool {
    if !crate::pane_ledger::ledger_resolve_identity(
        state,
        terminal_id,
        "antigravity",
        conversation_id,
        cwd,
    )
    .await
    {
        tracing::warn!(
            target: "freshell_ws::antigravity_association",
            terminal_id = %terminal_id,
            conversation_id = %conversation_id,
            event = "antigravity_identity.binding_failed",
            outcome = "refused",
            failure_reason = "DURABLE_BINDING_WRITE_FAILED",
            "antigravity_identity_binding_failed: the durable binding write failed — \
             nothing installed or announced (the identity homes keep the prior state)"
        );
        return false;
    }
    state.identity.upsert(
        terminal_id,
        Some("antigravity"),
        Some(conversation_id),
        cwd,
        now_ms(),
    );
    // Unified agent names: the transcript IS the verified persistence
    // evidence (the locator's whole job is finding persisted
    // transcripts), carried through the antigravity native location the
    // protocol gained in this task. Task 9 wires the create-side pending
    // handle surfaces; the bind itself is the shared transfer.
    if let Some(transcript) = transcript_path {
        let home = state
            .activity
            .as_ref()
            .and_then(|hub| hub.antigravity_association())
            .map(|association| {
                association
                    .antigravity_home()
                    .to_string_lossy()
                    .into_owned()
            })
            .unwrap_or_default();
        let acquisition = freshell_protocol::native_location::NativeAcquisition {
            location: freshell_protocol::native_location::NativeLocation::Antigravity {
                home,
                conversation_id: conversation_id.to_string(),
                transcript_path: Some(transcript.display().to_string()),
            },
            evidence: freshell_protocol::native_location::NativeEvidenceKind::PersistedMetadata,
            persistence: freshell_protocol::native_location::NativePersistence::Verified,
        };
        crate::identity::bind_pending_naming(
            &state.identity,
            &state.registry,
            terminal_id,
            freshell_protocol::session_names::NamedProvider::Antigravity,
            conversation_id,
            acquisition,
        )
        .await;
    }
    // Name reliability (G45): a conversation switch moved the identity's
    // durable ref; the terminal row's binding follows it.
    crate::terminal_naming::follow_identity_switch(state, terminal_id).await;
    state.registry.set_meta(
        terminal_id,
        None,
        None,
        Some("antigravity".to_string()),
        Some(conversation_id.to_string()),
    );
    // Structured JSONL: the bind/rebound evidence events.
    if let Some(previous) = previous_conversation_id {
        tracing::info!(
            target: "freshell_ws::antigravity_association",
            terminal_id = %terminal_id,
            conversation_id = %conversation_id,
            previous_conversation_id = %previous,
            event = "antigravity_identity_rebound",
            "antigravity_identity_rebound: pane identity moved to the switched conversation"
        );
    } else {
        tracing::info!(
            target: "freshell_ws::antigravity_association",
            terminal_id = %terminal_id,
            conversation_id = %conversation_id,
            event = "antigravity_identity_bound",
            "antigravity_identity_bound: pane identity bound to the located conversation"
        );
    }
    crate::codex_identity::broadcast_terminal_session_associated(
        state,
        "antigravity",
        terminal_id,
        conversation_id,
        cwd.map(str::to_string),
        previous_conversation_id.map(str::to_string),
    );
    // Antigravity plan Task 8: bind the activity lane to the pane's now-
    // durable conversation (adopt AND rebind land here). Channel-deferred
    // by the hub — the lane attach, watcher, and every frame it mints run
    // on the hub task. The located submit's `at` rides along as the
    // lane's BASELINE BOUNDARY (round 2, Major 2): settles on disk that
    // predate the submit are historical and silent; a settle after it
    // (a quick turn that landed during the locator's window) rings.
    if let (Some(hub), Some(transcript)) = (&state.activity, transcript_path) {
        hub.attach_antigravity_association(
            terminal_id,
            conversation_id,
            transcript,
            Some(submit_at_ms),
        );
    }
    true
}

/// Whether an antigravity association is installed on the state's hub (the
/// boot sweep registration's gate — the whole lane no-ops otherwise).
pub fn association_installed(state: &WsState) -> bool {
    state
        .activity
        .as_ref()
        .is_some_and(|hub| hub.antigravity_association().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-antigravity-association-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn association_for(label: &str) -> (Arc<AntigravityAssociation>, std::path::PathBuf) {
        let home = unique_temp_dir(label);
        let association = Arc::new(AntigravityAssociation::new(home.clone()));
        (association, home)
    }

    /// The brain-root wiring: the association's locator root IS the
    /// layout's `brain/` subtree of the resolved home.
    #[test]
    fn locator_root_is_the_layouts_brain_subtree() {
        let (association, home) = association_for("brain-root");
        let transcript = home
            .join("brain")
            .join("conv-1")
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(&transcript, "").unwrap();
        assert_eq!(association.locator().armed_count(), 0);
        assert_eq!(
            association.antigravity_home(),
            home.as_path(),
            "the naming acquisition's home is the resolved antigravity home"
        );
    }

    #[test]
    fn note_created_tags_only_antigravity_panes() {
        let (association, _home) = association_for("created");
        association.note_created("t1", "antigravity");
        association.note_created("t2", "codex");
        association.note_created("t3", "shell");
        association.note_created("", "antigravity");
        assert_eq!(
            association.pane_ids(),
            vec!["t1".to_string()],
            "only antigravity panes buffer input"
        );
        // The tagged half of the Input intake (the hub's #612 quit-intent
        // gate for antigravity panes): a tagged pane reports true, every
        // other pane false — in the same lock scope as the capture.
        let (flushed, tagged) = association.note_input_tagged("t1", "x\r", 1_000);
        assert!(tagged, "a tagged antigravity pane reports tagged");
        assert!(flushed);
        let (_, tagged) = association.note_input_tagged("t2", "x\r", 1_000);
        assert!(!tagged, "a codex pane is never tagged");
        let (_, tagged) = association.note_input_tagged("t-unknown", "x\r", 1_000);
        assert!(!tagged, "an unknown pane is never tagged");
    }

    #[test]
    fn input_capture_flushes_at_enter_bytes_and_handles_edits() {
        let (association, _home) = association_for("capture");
        association.note_created("t1", "antigravity");
        // Text arrives in chunks; the Enter byte flushes.
        assert!(!association.note_input("t1", "hel", 1_000));
        assert!(!association.note_input("t1", "lo", 1_001));
        assert!(association.note_input("t1", "\r", 1_002));
        // A paste (xterm.js `prepareTextForTerminal` converts pasted
        // `\r?\n` to `\r` before the bytes ever reach the PTY) flushes
        // within one chunk at its converted CR.
        assert!(association.note_input("t1", "second line\r", 2_000));
        // A bare Enter on an empty line never flushes.
        assert!(!association.note_input("t1", "\r", 3_000));
        // Backspace pops the buffered char (the CLI records the edited
        // line, so the capture must match it).
        assert!(!association.note_input("t1", "abcx", 4_000));
        assert!(!association.note_input("t1", "\u{7f}", 4_001));
        assert!(association.note_input("t1", "\r", 4_002));
        // Arrow keys (CSI sequences) are dropped whole.
        assert!(!association.note_input("t1", "\u{1b}[A", 5_000));
        assert!(!association.note_input("t1", "d", 5_001));
        assert!(association.note_input("t1", "\r", 5_002));
        // Untagged panes never buffer.
        assert!(!association.note_input("t-unknown", "x\r", 6_000));
        let submits = association.take_pending_submits();
        assert_eq!(
            submits,
            vec![
                ("t1".to_string(), "hello".to_string(), 1_002),
                ("t1".to_string(), "second line".to_string(), 2_000),
                ("t1".to_string(), "abc".to_string(), 4_002),
                ("t1".to_string(), "d".to_string(), 5_002),
            ],
            "flushed lines carry their Enter timestamps"
        );
        assert!(
            association.take_pending_submits().is_empty(),
            "take drains the queue"
        );
    }

    /// Whole-delta review Major 2: Antigravity documents Ctrl+J as
    /// inserting a newline INTO the prompt (multiline prompts are a
    /// normal coding workflow). The capture must flush ONLY on the
    /// submit key (Enter — the terminal sends CR); LF (Ctrl+J) JOINS the
    /// current buffer as inline newline content, so the flushed submit
    /// carries the FULL multi-line prompt and the locator can bind it to
    /// the transcript's multi-line user record.
    #[test]
    fn multiline_ctrl_j_prompt_joins_the_buffer_and_flushes_at_enter() {
        let (association, _home) = association_for("multiline-capture");
        association.note_created("t1", "antigravity");
        // The two-line prompt's bytes: `line1` `\n` (Ctrl+J) `line2` `\r`
        // (Enter). The Ctrl+J is CONTENT, never a submit: nothing flushes
        // and the hub's provisional-busy signal (the `flushed` half)
        // stays quiet for it.
        assert!(!association.note_input("t1", "line1", 1_000));
        assert!(
            !association.note_input("t1", "\n", 1_001),
            "Ctrl+J joins the buffer as inline newline content, it never submits"
        );
        assert!(!association.note_input("t1", "line2", 1_002));
        // Enter flushes the FULL two-line buffer as ONE submit.
        assert!(association.note_input("t1", "\r", 1_003));
        let submits = association.take_pending_submits();
        assert_eq!(
            submits,
            vec![("t1".to_string(), "line1\nline2".to_string(), 1_003)],
            "the submit payload is the full multi-line prompt"
        );
        // A leading Ctrl+J on an empty buffer normalizes away: the
        // submit's payload trims (the locator's `note_submit`
        // normalization), so a prompt that starts with a newline binds
        // the same record text.
        assert!(!association.note_input("t1", "\nsecond line", 2_000));
        assert!(association.note_input("t1", "\r", 2_001));
        let submits = association.take_pending_submits();
        assert_eq!(
            submits,
            vec![("t1".to_string(), "\nsecond line".to_string(), 2_001)],
            "the raw buffer is captured verbatim (trimmed at the locator)"
        );
    }

    #[test]
    fn note_exit_drops_the_capture_and_returns_whether_known() {
        let (association, _home) = association_for("exit");
        association.note_created("t1", "antigravity");
        assert!(association.note_exit("t1"));
        assert!(!association.note_exit("t1"), "idempotent second exit");
        assert!(!association.note_exit("t-unknown"));
        association.note_created("t2", "antigravity");
        association.discard("t2");
        assert!(association.pane_ids().is_empty());
    }

    /// A naming sink that records every `bind_pending` input (the
    /// `identity.rs` `BindRecordingSink` shape, extended to capture the
    /// full acquisition).
    #[derive(Default)]
    struct AcquisitionRecordingSink {
        binds: std::sync::Mutex<
            Vec<(
                freshell_protocol::session_names::SessionNameRef,
                freshell_protocol::session_names::SessionNameRef,
                freshell_protocol::native_location::NativeAcquisition,
            )>,
        >,
    }

    fn update_for(
        record: freshell_protocol::session_names::SessionNameRecord,
    ) -> freshell_protocol::session_names::SessionNameUpdate {
        freshell_protocol::session_names::SessionNameUpdate {
            redirects: Vec::new(),
            record,
            document_generation: 1,
            changed: true,
            native_sync: None,
            outcome: None,
        }
    }

    impl freshell_freshagent::naming::SessionNaming for AcquisitionRecordingSink {
        fn get(
            &self,
            refs: Vec<freshell_protocol::session_names::SessionNameRef>,
        ) -> freshell_freshagent::naming::NameFuture<
            Vec<freshell_protocol::session_names::SessionNameUpdate>,
        > {
            let updates = refs
                .into_iter()
                .map(|target| {
                    update_for(freshell_protocol::session_names::SessionNameRecord {
                        name_ref: target,
                        name: "unit".into(),
                        source: freshell_protocol::session_names::NameSource::Directory,
                        revision: 1,
                        manual_revision: None,
                        renamed_at: None,
                        legacy_origin: None,
                    })
                })
                .collect();
            Box::pin(async move { Ok(updates) })
        }

        fn ensure_pending(
            &self,
            _input: freshell_freshagent::naming::PendingNameInput,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }

        fn bind_pending(
            &self,
            input: freshell_freshagent::naming::BindNameInput,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            self.binds.lock().unwrap().push((
                input.pending.clone(),
                input.target.clone(),
                input.acquisition.clone(),
            ));
            let record = freshell_protocol::session_names::SessionNameRecord {
                name_ref: input.target,
                name: "bound".into(),
                source: freshell_protocol::session_names::NameSource::Directory,
                revision: 2,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            };
            Box::pin(async move { Ok(update_for(record)) })
        }

        fn rename(
            &self,
            _input: freshell_freshagent::naming::RenameNameInput,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }

        fn activity(
            &self,
            _input: freshell_freshagent::naming::NameActivity,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }

        fn observe_native(
            &self,
            _input: freshell_freshagent::naming::NativeNameObservation,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }

        fn record_acquisition(
            &self,
            _target: freshell_protocol::session_names::SessionNameRef,
            _acquisition: freshell_protocol::native_location::NativeAcquisition,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }
    }

    /// The full test `WsState` (the `codex_association.rs` fixture shape):
    /// a real activity hub carrying the association (its registry
    /// observer installed, so Input events reach the capture), an
    /// enabled-or-disabled pane ledger, and the recording naming sink.
    fn state_with_association(
        home: std::path::PathBuf,
        ledger_dir: Option<&std::path::Path>,
        naming: Option<Arc<AcquisitionRecordingSink>>,
    ) -> (
        WsState,
        tokio::sync::broadcast::Receiver<String>,
        Arc<AntigravityAssociation>,
    ) {
        let auth_token = Arc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
        let rx = broadcast_tx.subscribe();
        let registry = freshell_terminal::TerminalRegistry::new();
        let identity = crate::identity::TerminalIdentityRegistry::new();
        if let Some(sink) = naming {
            identity.set_session_naming(sink);
        }
        let hub = crate::activity::ActivityHub::new(Arc::clone(&broadcast_tx), None);
        let association = Arc::new(AntigravityAssociation::new(home));
        hub.set_antigravity_association(Arc::clone(&association));
        registry.set_activity_observer(hub.registry_observer());
        let pane_ledger = match ledger_dir {
            Some(dir) => Arc::new(crate::pane_ledger::PaneLedger::new(Some(dir.to_path_buf()))),
            None => Arc::new(crate::pane_ledger::PaneLedger::disabled()),
        };
        let state = WsState {
            pane_ledger,
            layout: Default::default(),
            terminal_meta: Default::default(),
            identity,
            auth_token: Arc::clone(&auth_token),
            server_instance_id: Arc::new("srv-1111".to_string()),
            boot_id: Arc::new("boot-2222".to_string()),
            settings: Arc::new(crate::test_settings()),
            handshake_settings: Arc::new(tokio::sync::RwLock::new(crate::test_settings())),
            broadcast_tx: Arc::clone(&broadcast_tx),
            auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
            auto_resume_cancels: Default::default(),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            ),
            fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
            fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(auth_token, Arc::clone(&broadcast_tx)),
            ),
            registry,
            shutdown: Arc::new(tokio::sync::Notify::new()),
            tabs: crate::tabs::TabsRegistry::new(),
            screenshots: crate::screenshot::ScreenshotBroker::new(broadcast_tx),
            subagent_interest: Default::default(),
            host_stats: Default::default(),
            checkpoint_send: Default::default(),
            terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            cli_commands: Arc::new(Vec::new()),
            ping_interval_ms: 30_000,
            hello_timeout_ms: 5_000,
            allowed_origins: Arc::new(crate::origin::default_allowed_origins()),
            ws_max_payload_bytes: 16 * 1024 * 1024,
            term09: crate::backpressure::Term09Config::default(),
            create_protect: crate::create_limit::CreateProtectConfig::default(),
            spawn_gate: Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            shutdown_started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            create_dedupe: Arc::new(crate::create_dedupe::CreateDedupe::default()),
            config_fallback: None,
            opencode_locator: None,
            codex_locator: None,
            activity: Some(hub),
            session_existence: Arc::new(crate::existence::NoIndexProbe::default()),
            reconcile_deferral_budget_ms: crate::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
            fresh_agent_respawn_counts: Default::default(),
            ownership: None,
        };
        (state, rx, association)
    }

    /// Spawn a real PTY the registry lists as a running antigravity
    /// terminal (the codex fixture's spawn discipline).
    fn spawn_antigravity_pty(state: &WsState, terminal_id: &str, cwd: &str) {
        let spec = freshell_platform::build_spawn_spec(
            freshell_platform::ShellType::System,
            freshell_platform::detect::HostOs::Linux,
            false,
            Some(cwd),
            &freshell_platform::RealEnv,
            &freshell_platform::RealFileProbe,
            &std::collections::BTreeMap::new(),
            None,
            None,
        );
        state
            .registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                terminal_id.to_string(),
                format!("stream-{terminal_id}"),
                "antigravity",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real PTY for the test");
        state.registry.set_meta(
            terminal_id,
            None,
            None,
            Some("antigravity".to_string()),
            None,
        );
    }

    /// Plant a fixture-format transcript under the association's brain
    /// root (numeric epoch-ms `at` — the coercion's second form).
    fn plant_transcript(
        home: &std::path::Path,
        conv: &str,
        cwd: &str,
        records: &[(&str, i64)],
    ) -> std::path::PathBuf {
        let path = home
            .join("brain")
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

    /// End to end through the sweep body: a real antigravity PTY, a
    /// captured submit, a matching transcript → the drain adopts through
    /// the tail: durable ledger row first (pending marker consumed),
    /// identity row, registry meta, the pinned associated-then-meta
    /// broadcast order, and the naming bind carrying the antigravity
    /// native location.
    #[tokio::test]
    async fn drain_and_associate_binds_identity_ledger_naming_and_broadcasts() {
        let home = unique_temp_dir("drain-adopt");
        let ledger_dir = unique_temp_dir("drain-adopt-ledger");
        let naming = Arc::new(AcquisitionRecordingSink::default());
        let cwd_dir = unique_temp_dir("drain-adopt-cwd");
        let cwd = cwd_dir.to_string_lossy().into_owned();
        let (state, mut rx, association) =
            state_with_association(home.clone(), Some(&ledger_dir), Some(Arc::clone(&naming)));

        spawn_antigravity_pty(&state, "t1", &cwd);
        // The hub-side Created tag (production: the hub's Created arm).
        association.note_created("t1", "antigravity");
        // The pending naming handle the create surface would have minted
        // (Task 9 wires that side; the retained handle is the shared
        // precondition `bind_pending_naming` consumes).
        state.identity.set_name_binding(
            "t1",
            Some(freshell_protocol::session_names::SessionNameRef::Pending {
                id: "nh-agy-1".into(),
            }),
            Some("nh-agy-1".into()),
        );

        // The spawn-time pending marker (production: handle_create's
        // MARKER_MODES branch writes it).
        state
            .pane_ledger
            .record_pending(
                "t1",
                "antigravity",
                Some(&cwd),
                None,
                crate::pane_ledger::ProvenanceStamps::default(),
                now_ms(),
            )
            .unwrap();

        // The captured submit (production: the hub's Input arm feeding
        // the association from ActivityEvent::Input).
        assert!(association.note_input("t1", "unit drain prompt\r", now_ms()));
        plant_transcript(
            &home,
            "conv-drain-1",
            &cwd,
            &[("unit drain prompt", now_ms())],
        );

        // Drain repeatedly until the window closes relative to wall
        // clock (the sweep drives this in production).
        tokio::time::sleep(std::time::Duration::from_millis(
            freshell_sessions::antigravity_locator::ANTIGRAVITY_WINDOW_MS as u64 + 150,
        ))
        .await;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if state.identity.session_ref_for("t1").is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        let expected_ref = freshell_protocol::SessionLocator {
            provider: "antigravity".to_string(),
            session_id: "conv-drain-1".to_string(),
        };
        assert_eq!(state.identity.session_ref_for("t1"), Some(expected_ref));
        let dir_entry = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "t1")
            .unwrap();
        assert_eq!(dir_entry.resume_session_id.as_deref(), Some("conv-drain-1"));
        let hit = state
            .pane_ledger
            .lookup_by_session("antigravity", "conv-drain-1")
            .expect("binding row written at resolution");
        assert_eq!(hit.row.live_terminal_id.as_deref(), Some("t1"));
        assert!(
            state.pane_ledger.pending_for_terminal("t1").is_none(),
            "resolution consumed the pending marker"
        );

        // The naming bind carries NamedProvider::Antigravity and the
        // NativeLocation::Antigravity acquisition with the association's
        // resolved home + the verified transcript path.
        let binds = naming.binds.lock().unwrap();
        assert_eq!(binds.len(), 1, "{binds:?}");
        let (pending, target, acquisition) = &binds[0];
        assert_eq!(
            *pending,
            freshell_protocol::session_names::SessionNameRef::Pending {
                id: "nh-agy-1".into()
            }
        );
        assert_eq!(
            *target,
            freshell_protocol::session_names::SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Antigravity,
                session_id: "conv-drain-1".into(),
            }
        );
        assert_eq!(
            acquisition.location,
            freshell_protocol::native_location::NativeLocation::Antigravity {
                home: home.to_string_lossy().into_owned(),
                conversation_id: "conv-drain-1".into(),
                transcript_path: Some(
                    home.join("brain/conv-drain-1/.system_generated/logs/transcript.jsonl")
                        .to_string_lossy()
                        .into_owned()
                ),
            }
        );
        assert_eq!(
            acquisition.persistence,
            freshell_protocol::native_location::NativePersistence::Verified
        );
        drop(binds);

        // Broadcasts, in the pinned order: `terminal.session.associated`
        // FIRST, then `terminal.meta.updated`.
        let mut frames = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        let associated_at = frames
            .iter()
            .position(|f| f.contains("terminal.session.associated") && f.contains("conv-drain-1"))
            .expect("expected a terminal.session.associated broadcast");
        let meta_at = frames
            .iter()
            .position(|f| f.contains("terminal.meta.updated") && f.contains("conv-drain-1"))
            .expect("expected a terminal.meta.updated broadcast");
        assert!(
            associated_at < meta_at,
            "pinned order: associated THEN meta.updated"
        );

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_dir);
        let _ = std::fs::remove_dir_all(&cwd_dir);
    }

    /// Whole-delta review Major 2, end to end through the sweep: a pane
    /// that submits a TWO-LINE prompt (Ctrl+J between the lines — the
    /// CLI's documented multiline form) binds to the transcript whose
    /// user record carries BOTH lines. Pre-fix, the capture flushed
    /// "line1" at the LF byte and "line2" at the Enter byte; the
    /// locator's window kept only the LAST line ("line2"), which can
    /// never equal the transcript's full `line1\nline2` user record —
    /// multiline prompts could never bind.
    #[tokio::test]
    async fn multiline_prompt_binds_through_the_drain() {
        let home = unique_temp_dir("multiline-drain");
        let ledger_dir = unique_temp_dir("multiline-drain-ledger");
        let naming = Arc::new(AcquisitionRecordingSink::default());
        let cwd_dir = unique_temp_dir("multiline-drain-cwd");
        let cwd = cwd_dir.to_string_lossy().into_owned();
        let (state, _rx, association) =
            state_with_association(home.clone(), Some(&ledger_dir), Some(Arc::clone(&naming)));

        spawn_antigravity_pty(&state, "t1", &cwd);
        association.note_created("t1", "antigravity");
        state
            .pane_ledger
            .record_pending(
                "t1",
                "antigravity",
                Some(&cwd),
                None,
                crate::pane_ledger::ProvenanceStamps::default(),
                now_ms(),
            )
            .unwrap();

        // The pane's two-line prompt, byte for byte: `line1`, Ctrl+J
        // (`\n`), `line2`, Enter (`\r`) — ONE submit carrying the full
        // multi-line buffer.
        let t0 = now_ms();
        assert!(!association.note_input("t1", "line1", t0));
        assert!(!association.note_input("t1", "\n", t0 + 1));
        assert!(!association.note_input("t1", "line2", t0 + 2));
        assert!(association.note_input("t1", "\r", t0 + 3));
        // The transcript's user record carries BOTH lines (JSON-escaped
        // newline inside the record text — the CLI's recorded form for a
        // multiline prompt).
        plant_transcript(&home, "conv-multiline", &cwd, &[("line1\\nline2", t0 + 10)]);

        tokio::time::sleep(std::time::Duration::from_millis(
            freshell_sessions::antigravity_locator::ANTIGRAVITY_WINDOW_MS as u64 + 150,
        ))
        .await;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if state.identity.session_ref_for("t1").is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let expected_ref = freshell_protocol::SessionLocator {
            provider: "antigravity".to_string(),
            session_id: "conv-multiline".to_string(),
        };
        assert_eq!(
            state.identity.session_ref_for("t1"),
            Some(expected_ref),
            "a two-line prompt binds the transcript whose user record carries both lines"
        );

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_dir);
        let _ = std::fs::remove_dir_all(&cwd_dir);
    }

    /// A8 (retired-inclusive): a conversation bound to a DEAD pane's
    /// identity row repels adoption by a fresh pane — resolution happens
    /// (the locator disarms its window) but the tail's guard installs
    /// nothing.
    #[tokio::test]
    async fn located_conversation_bound_elsewhere_is_rejected() {
        let home = unique_temp_dir("a8-elsewhere");
        let cwd_dir = unique_temp_dir("a8-cwd");
        let cwd = cwd_dir.to_string_lossy().into_owned();
        let (state, _rx, association) = state_with_association(home.clone(), None, None);

        // A victim pane's binding, RETIRED — the state the exit path
        // leaves behind.
        state.identity.upsert(
            "victim",
            Some("antigravity"),
            Some("conv-taken"),
            Some(&cwd),
            now_ms(),
        );
        assert!(state.identity.retire("victim"));

        spawn_antigravity_pty(&state, "t1", &cwd);
        association.note_created("t1", "antigravity");
        assert!(association.note_input("t1", "stolen prompt attempt\r", now_ms()));
        plant_transcript(
            &home,
            "conv-taken",
            &cwd,
            &[("stolen prompt attempt", now_ms())],
        );

        tokio::time::sleep(std::time::Duration::from_millis(
            freshell_sessions::antigravity_locator::ANTIGRAVITY_WINDOW_MS as u64 + 150,
        ))
        .await;
        // Drain well past the window. The positive resolution signal is
        // the locator's scan counter (the pane stays ARMED after
        // resolution — the unified rule keeps evaluating later submits),
        // so the refusal below cannot pass vacuously: the window WAS
        // evaluated against a fully-matching transcript.
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if association.locator().fs_scan_count() >= 1
                && state.identity.session_ref_for("t1").is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            association.locator().fs_scan_count() >= 1,
            "the window was evaluated (the scan ran)"
        );
        assert!(
            state.identity.session_ref_for("t1").is_none(),
            "the A8 guard refused the retired-inclusive bound conversation"
        );

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd_dir);
    }

    /// A13: a conversation LIVE-owned by another pane is refused.
    #[tokio::test]
    async fn located_conversation_live_owned_elsewhere_is_rejected() {
        let home = unique_temp_dir("a13-live-owner");
        let cwd_dir = unique_temp_dir("a13-cwd");
        let cwd = cwd_dir.to_string_lossy().into_owned();
        let (state, _rx, association) = state_with_association(home.clone(), None, None);

        // A live owner pane holds the conversation.
        spawn_antigravity_pty(&state, "owner", &cwd);
        state.identity.upsert(
            "owner",
            Some("antigravity"),
            Some("conv-owned"),
            Some(&cwd),
            now_ms(),
        );

        spawn_antigravity_pty(&state, "t1", &cwd);
        association.note_created("t1", "antigravity");
        assert!(association.note_input("t1", "hijack prompt\r", now_ms()));
        plant_transcript(&home, "conv-owned", &cwd, &[("hijack prompt", now_ms())]);

        tokio::time::sleep(std::time::Duration::from_millis(
            freshell_sessions::antigravity_locator::ANTIGRAVITY_WINDOW_MS as u64 + 150,
        ))
        .await;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if association.locator().fs_scan_count() >= 1
                && state.identity.session_ref_for("t1").is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            association.locator().fs_scan_count() >= 1,
            "the window was evaluated (the scan ran)"
        );
        assert!(
            state.identity.session_ref_for("t1").is_none(),
            "the A13 guard refused the live-owned conversation"
        );

        state.registry.kill("owner");
        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd_dir);
    }

    /// The rebind path through the drain: a bound pane whose next submit
    /// matches a NEW conversation moves the identity (supersede recorded
    /// on the broadcast, both homes follow).
    #[tokio::test]
    async fn drain_rebinds_a_bound_pane_to_the_switched_conversation() {
        let home = unique_temp_dir("rebind");
        let cwd_dir = unique_temp_dir("rebind-cwd");
        let cwd = cwd_dir.to_string_lossy().into_owned();
        let (state, mut rx, association) = state_with_association(home.clone(), None, None);

        spawn_antigravity_pty(&state, "t1", &cwd);
        association.note_created("t1", "antigravity");
        // The pane is already bound to conv-old (an earlier adoption).
        state.identity.upsert(
            "t1",
            Some("antigravity"),
            Some("conv-old"),
            Some(&cwd),
            now_ms(),
        );
        state.registry.set_meta(
            "t1",
            None,
            None,
            Some("antigravity".to_string()),
            Some("conv-old".to_string()),
        );
        plant_transcript(&home, "conv-old", &cwd, &[("the old prompt", T0)]);

        // The next submit lands in the switched conversation's
        // transcript (the /switch form).
        assert!(association.note_input("t1", "the switched prompt\r", now_ms()));
        let new_path = plant_transcript(
            &home,
            "conv-new",
            &cwd,
            &[("the switched prompt", now_ms())],
        );

        tokio::time::sleep(std::time::Duration::from_millis(
            freshell_sessions::antigravity_locator::ANTIGRAVITY_WINDOW_MS as u64 + 150,
        ))
        .await;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if state
                .identity
                .session_ref_for("t1")
                .is_some_and(|r| r.session_id == "conv-new")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        assert_eq!(
            state.identity.session_ref_for("t1"),
            Some(freshell_protocol::SessionLocator {
                provider: "antigravity".to_string(),
                session_id: "conv-new".to_string(),
            }),
            "the rebind moved the identity home"
        );
        let dir_entry = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "t1")
            .unwrap();
        assert_eq!(dir_entry.resume_session_id.as_deref(), Some("conv-new"));

        // The rebind broadcast names the superseded conversation.
        let mut rebind_frame: Option<serde_json::Value> = None;
        while let Ok(frame) = rx.try_recv() {
            let parsed: serde_json::Value = serde_json::from_str(&frame).expect("json frame");
            if parsed["type"] == "terminal.session.associated"
                && parsed["terminalId"] == "t1"
                && parsed["previousSessionId"] == "conv-old"
            {
                rebind_frame = Some(parsed);
            }
        }
        let rebind_frame = rebind_frame.expect("the rebind broadcast carries previousSessionId");
        assert_eq!(rebind_frame["sessionRef"]["sessionId"], "conv-new");
        assert!(new_path.exists());

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd_dir);
    }

    /// The hub wiring: Created tags, Input flushes through the real
    /// registry observer, Exit untags — the seam the production hub uses.
    /// The observer enqueues onto the hub task's channel, so each step is
    /// polled to its observable effect (bounded).
    #[tokio::test]
    async fn hub_observer_feeds_the_association_lifecycle() {
        let home = unique_temp_dir("hub-lifecycle");
        let (state, _rx, association) = state_with_association(home, None, None);
        let observer = state
            .activity
            .as_ref()
            .expect("hub wired")
            .registry_observer();
        observer(freshell_terminal::ActivityEvent::Created {
            terminal_id: "t1".into(),
            mode: "antigravity".into(),
            resume_session_id: None,
            at: now_ms(),
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while association.pane_ids() != vec!["t1".to_string()] {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the hub task never processed the Created event"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        observer(freshell_terminal::ActivityEvent::Input {
            terminal_id: "t1".into(),
            data: "hello\r".into(),
            at: now_ms(),
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while association.take_pending_submits().is_empty() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the hub task never processed the Input event"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        observer(freshell_terminal::ActivityEvent::Exit {
            terminal_id: "t1".into(),
            at: now_ms(),
            spontaneous: true,
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while !association.pane_ids().is_empty() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the hub task never processed the Exit event"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}
