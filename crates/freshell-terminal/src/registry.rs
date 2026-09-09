//! Server-side terminal **registry** — the port of `server/terminal-registry.ts`
//! ownership model + the multi-client fan-out of `server/terminal-stream/broker.ts`,
//! reduced to the `mode:'shell'` path (`port/machine/specs/terminal-core.md` §1).
//!
//! ## Why this exists (the T3 breadth gap)
//!
//! In 3.4b a terminal was owned by the WS connection that created it: its PTY and
//! its produced `terminal.output` frames lived on the connection, streamed only to
//! that one socket, and were killed when it closed. That fails every
//! detach/attach/background-session flow — a *second* or *reconnected* socket has
//! no shared object to re-attach to (`multi-client`, `reconnection`, `tab-management`
//! hot-across-reload).
//!
//! This registry moves ownership off the connection: a terminal (PTY + its seq'd
//! replay log + geometry) is keyed by `terminalId` and outlives any socket. Per the
//! spec's state machine (`§1.2`):
//!
//! * **create** registers a running terminal (PTY spawned, no client attached yet).
//! * **attach** from ANY connection sends `terminal.attach.ready`, then **replays the
//!   scrollback** (frames with `seqStart > sinceSeq`) and streams live — the
//!   snapshot-on-attach + live handoff (`§3.5`, `broker.ts:312-610`).
//! * **detach / socket-close** removes that connection's subscription but leaves the
//!   PTY **running** — `detached ≡ clients.size === 0` while `running` (`§1.2`, the
//!   background session).
//! * **kill / exit** removes the terminal and sends `terminal.exit` to every
//!   attached connection (`§1.2`, `§6.3`).
//!
//! ## Concurrency (`§7`)
//!
//! Each terminal owns an `Arc<Mutex<TerminalShared>>` holding its replay log +
//! subscriber set. The PTY reader thread's sink ([`ingest`]) locks it to append one
//! frame and fan it out; an attach locks it to snapshot the replay set and register
//! the subscriber. Because both take the SAME per-terminal lock, an attach that
//! registers a subscriber and enqueues the replay while holding the lock guarantees
//! **replay-then-live** ordering with no gap and no duplicate across the handoff
//! (the reader can't append until the attach releases the lock; frames it then
//! appends are strictly newer than the replayed span). Per-terminal seq order and
//! the `attachRequestId` stamping from 3.10 are preserved: every frame a connection
//! receives is stamped with THAT connection's active `attachRequestId`.
//!
//! Transport-agnostic on purpose: a subscriber is a bare [`FrameSink`] callback, so
//! this crate keeps its no-tokio boundary (`freshell-ws` backs the sink with a tokio
//! mpsc sender feeding the socket).

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use freshell_platform::SpawnSpec;
use freshell_protocol::{
    GeometryAuthority, InventoryTerminal, OutputSource, ServerMessage, SessionLocator,
    TerminalAttachIntent, TerminalAttachReady, TerminalExit, TerminalModesSync, TerminalOutput,
    TerminalOutputGap, TerminalOutputGapReason, TerminalReplayResetReason, TerminalRunStatus,
    TerminalStreamChanged, TerminalStreamChangedReason, TerminalStuck,
};

use crate::barrier_scanner::{BarrierReason, BarrierScanner, ScannerState};
use crate::batch::{
    build_batch_wire_payloads, build_terminal_output_batches, utf16_len, BatchBuildInput,
    BatchInputFrame,
};
use crate::fragment::terminal_stream_batch_max_bytes;
use crate::idle_noise::NoiseScanner;
use crate::mode_tracker::ModeTracker;
use crate::pty::{MessageSink, PtyTerminal};

/// Deliver one server→client message to a single attached connection's socket.
/// Kept as an `Arc`'d `Fn` so the registry never depends on the transport: the
/// reader thread and attach path both invoke it, and `freshell-ws` provides one
/// that forwards into that connection's tokio mpsc → WebSocket.
pub type FrameSink = Arc<dyn Fn(ServerMessage) + Send + Sync>;

/// `DEFAULT_MAX_SCROLLBACK_CHARS` (`terminal-registry.ts:57`): the replay-log
/// byte cap used when no `settings.terminal.scrollback` value has been wired
/// into the registry yet (TERM-13's "absent" default -- mirrors the legacy
/// `computeScrollbackMaxChars`'s not-a-finite-number fallback).
const DEFAULT_MAX_SCROLLBACK_CHARS: i64 = 512 * 1024;
/// `MIN_SCROLLBACK_CHARS` (`terminal-registry.ts:58`).
const MIN_SCROLLBACK_CHARS: i64 = 64 * 1024;
/// `MAX_SCROLLBACK_CHARS` (`terminal-registry.ts:59`).
const MAX_SCROLLBACK_CHARS: i64 = 4 * 1024 * 1024;
/// `APPROX_CHARS_PER_LINE` (`terminal-registry.ts:60`).
const APPROX_CHARS_PER_LINE: i64 = 300;
/// Responsive-terminal-restore Workstream 1: the default serialized-byte
/// budget of ONE paced replay page (the plan's "128 KiB initial terminal
/// batch target" — a per-page delivery bound, NOT a claim about total
/// reconstruction size). The budget covers the JSON envelope, escaping,
/// and batch-segment metadata; a single frame whose own envelope exceeds it
/// forms its own atomic single-frame page (guaranteed progress). Held as a
/// registry-level atomic (like `scrollback_max_bytes`) so focused tests can
/// shrink it per-instance without env races.
pub const DEFAULT_PACED_PAGE_MAX_BYTES: i64 = 128 * 1024;

/// `computeScrollbackMaxChars(settings)` (`terminal-registry.ts:1328-1333`):
/// `settings.terminal.scrollback` LINES converted to an approximate **CHAR**
/// cap (UTF-16 code units, matching legacy `ChunkRingBuffer`'s `chunk.length`
/// accounting) via `APPROX_CHARS_PER_LINE`, clamped to
/// `[MIN_SCROLLBACK_CHARS, MAX_SCROLLBACK_CHARS]`. Callers (`freshell-server`'s
/// boot wiring) pass the real `settings.terminal.scrollback` value; the
/// registry's OWN default before any such wiring happens is
/// `DEFAULT_MAX_SCROLLBACK_CHARS` (see `TerminalRegistry::new`), matching the
/// legacy not-a-number fallback for a constructor called with no settings at
/// all.
///
/// NOTE (unit-honesty scope limit): this function, `TerminalRegistry::
/// scrollback_max_bytes`/`set_scrollback_max_bytes`, and the
/// `scrollback_max_bytes` field all keep their historical "bytes" names for
/// public-API stability -- `crates/freshell-server/src/main.rs` calls them
/// across the crate boundary, outside this fix's file ownership. Despite the
/// name, every one of them carries a CHAR (UTF-16 code-unit) budget, never a
/// byte budget. The consumer that actually measured this cap in bytes --
/// `TerminalShared::replay_chars`/`max_replay_chars` in this same file, see
/// `ingest()` below -- has been fixed to count chars, closing the real parity
/// gap (a reviewer "Important" finding on commit f7b2c9e6). Renaming the
/// public functions/fields is left for a follow-up that also touches
/// `freshell-server`.
pub fn compute_scrollback_max_bytes(scrollback_lines: i64) -> i64 {
    scrollback_lines
        .saturating_mul(APPROX_CHARS_PER_LINE)
        .clamp(MIN_SCROLLBACK_CHARS, MAX_SCROLLBACK_CHARS)
}

/// `Date.now()` — epoch milliseconds.
///
/// HARNESS-14: routed through the shared, env-gated test clock
/// (`freshell_platform::clock`). Gate OFF (every normal build/run) the call
/// is an identity passthrough to `SystemTime::now()`, so production behavior
/// is byte-identical; gate ON (a `FRESHELL_TEST_CLOCK=1` test boot) every
/// activity stamp AND the `enforce_idle_kills` threshold math move with the
/// one clock a spec can advance/freeze without wall-clock sleeps.
fn now_ms() -> i64 {
    freshell_platform::clock::now_ms()
}

/// Current restore-contract sequence bounds for one terminal's retained
/// replay ring (responsive-terminal-restore shared contract): the
/// terminal's head sequence and the earliest sequence position still
/// available for replay. Payload-free by design — the writer's gap frames
/// stamp these bounds without copying any retained output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayBounds {
    /// Highest produced `seqEnd` (drives `attach.ready.headSeq`).
    pub head_seq: i64,
    /// The retained ring's front `seqStart`, or `head_seq + 1` when the ring
    /// is empty (nothing older than the head is retained).
    pub oldest_retained_seq: i64,
}

/// Hidden-pane lifetime-claim observability
/// ([`TerminalRegistry::claim_state`], responsive-terminal-restore Workstream
/// 1): the claim set size and the row's fast-reap eligibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimState {
    /// Distinct connections currently claiming this terminal's lifetime.
    pub claimers: usize,
    /// Whether the row is configured-threshold reap-eligible (explicitly
    /// released — or never attached/claimed).
    pub released_by_client: bool,
}

/// Paced-attach inputs beyond the legacy wire fields
/// (responsive-terminal-restore round-2): the negotiated forward-page
/// limit the client requested (`replayPageBytes` — an optional UPPER BOUND
/// on each paced page's serialized bytes, clamped to the registry's own
/// [`TerminalRegistry::paced_page_max_bytes`] cap; finding F3) and the
/// connection's staged-exit notification hook (finding F1 — installed with
/// the paced subscriber, atomically with the attach, so a natural exit
/// while the deferral is armed can move the connection's session into its
/// exit-drain). Both are inert for non-paced attaches.
#[derive(Clone, Default)]
pub struct PacedAttachOptions {
    /// The attach's `replayPageBytes`: `Some(positive)` bounds every page
    /// of the session at `min(requested, registry cap)`; `None` (or a
    /// non-positive value, filtered at the protocol layer) keeps the
    /// server default.
    pub replay_page_bytes: Option<i64>,
    /// The connection's exit-sequencing hook (finding F1): invoked by
    /// `finish_pty_exit` — OUTSIDE the terminal lock — when a natural
    /// exit STAGES this subscriber's exit behind its still-armed
    /// deferral. Receives (terminal_id, exit_code); the ws layer routes
    /// it to the owning connection's dispatch loop, which hands the
    /// session to the exit-drain. Must never acquire the originating
    /// terminal's lock (it fires from the PTY reader thread).
    pub paced_exit_notify: Option<PacedExitNotify>,
}

/// The staged-exit notification hook for a paced subscriber (finding F1).
pub type PacedExitNotify = Arc<dyn Fn(&str, i64) + Send + Sync>;

/// E2R3 (the atomic exit-transition decision): the phase-transition
/// facts for one paced subscriber, read under ONE registry lock hold —
/// the staged-exit state AND the terminal's head TOGETHER, so no window
/// exists between the read and the caller's commitment of the
/// disposition in which a concurrently staged exit can change which
/// transition was correct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PacedExitTransition {
    /// The terminal's FROZEN final head when a natural exit is STAGED
    /// for this subscriber ([`TerminalRegistry::finish_pty_exit`]
    /// staged it behind the still-armed deferral): the credited phase
    /// extends through it, and terminal.exit rides the credit that
    /// acknowledges the page reaching it. `None` atomically confirms
    /// NO exit is staged as of this decision's lock hold — an exit
    /// staging after the hold is post-decision content (at the
    /// transfer site: the drain's documented uncredited tail
    /// semantics). The head is frozen by the exit, so a `Some` value
    /// is stable for the subscriber's remainder.
    pub exit_head: Option<i64>,
}

/// E2R3 (the atomic exit-transition decision) test-support: the armed
/// payload of the ONE-SHOT natural-exit staging hook — WHICH
/// connection's subscriber stages WHICH exit code when the next hook
/// site fires (see
/// [`TerminalRegistry::set_paced_exit_stage_hook_for_tests`]).
#[derive(Debug, Clone, Copy)]
struct PacedExitStageHook {
    conn_id: u64,
    exit_code: i64,
}

/// The ws pacing coordinator's session description for one paced replay
/// (responsive-terminal-restore Workstream 1): everything the coordinator
/// needs to gate continuation credits and drive page reads. Produced by the
/// paced attach, owned by the connection (one session per
/// (connection, terminal); a re-attach replaces it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacedSessionDesc {
    pub terminal_id: String,
    pub stream_id: String,
    /// The attach generation this session serves; stale-credit rejection key.
    pub attach_request_id: String,
    /// FIXED catch-up target: `head_seq` at attach time. Ongoing output never
    /// extends it — frames past the target are tail-phase delivery.
    pub target: i64,
    /// The effective replay baseline (the requested `sinceSeq` clamped to
    /// ≥ 0, reset to `oldest-1` on attach-time retention loss).
    pub effective_since: i64,
    /// The production cursor: the last seq sent in a page (== the first
    /// page's last seq; `effective_since` when the first page is empty).
    pub page_end: i64,
    /// The session's page budget (round-2 finding F3): the clamped
    /// effective bound (`min(requested replayPageBytes, registry cap)`,
    /// the registry cap when absent) that sized the FIRST page and bounds
    /// every later page — the whole session honors the request, not just
    /// the first page.
    pub page_budget: i64,
    /// Serialized wire bytes of the first page (observability).
    pub page_bytes: u64,
}

/// What a negotiated (paced) attach returns to the ws layer INSTEAD of an
/// inline replay burst: the session description plus the FIRST page's wire
/// messages. The ws layer sinks the page AFTER the terminal lock is
/// released; subsequent pages are produced on continuation credit and the
/// tail range `(target, head]` is drained as ordinary delivery.
#[derive(Debug, Clone, PartialEq)]
pub struct PacedAttachStart {
    pub session: PacedSessionDesc,
    pub first_page: Vec<ServerMessage>,
}

/// Result of [`TerminalRegistry::next_replay_page`] — one bounded,
/// ascending page of the `(from_seq, target]` window, the window's
/// completion, an exact retention-loss report, or the session's
/// disappearance.
#[derive(Debug, Clone, PartialEq)]
#[must_use]
pub enum PacedPage {
    /// One packed page: ascending wire messages, the page's last seq (the
    /// session's new cursor), and the page's total serialized bytes.
    Frames {
        messages: Vec<ServerMessage>,
        end_seq: i64,
        serialized_bytes: u64,
    },
    /// `from_seq >= target` — the replay window is fully delivered.
    Done,
    /// Retention evicted the frames the session needs next. The exact lost
    /// interval is `[lost_from, lost_to]` and the session continues from
    /// `resume_from` (the new ring front − 1); `head_seq`/`oldest_retained_seq`
    /// are the task-2 bounds fields for the negotiated gap frame.
    Expired {
        lost_from: i64,
        lost_to: i64,
        resume_from: i64,
        head_seq: i64,
        oldest_retained_seq: i64,
    },
    /// The terminal (or this connection's subscriber) is gone — cancel the
    /// session; there is no deferral left to clear.
    Gone,
}

/// Result of [`TerminalRegistry::complete_paced_tail`] and
/// [`TerminalRegistry::handoff_paced_tail`] — the terminal phase's PAGED,
/// FIXED-BOUNDARY completion: the drain pages toward the FIXED target
/// captured once at drain start (the caller passes it; it is NEVER
/// re-captured), each call delivers at most one budget-bounded page (the
/// lock held only per page), and when the target is covered the
/// COMPLETION BOUNDARY B is captured ONCE under that same hold (the
/// `TargetCovered` verdict — "completion start", recorded on the
/// subscriber as `paced_handoff_boundary`). The post-target handoff then
/// delivers the staged window up to B and ONLY B — one budget-bounded
/// chunk per lock hold, the lock released between chunks, never a bulk
/// retained-suffix clone, NEVER re-reading the terminal's current head
/// (the recurring moving-head chase cause; the handoff structurally
/// contains no head read). The completing hold clears the deferral
/// ATOMICALLY in the same lock hold as its delivery, and the frames the
/// producer staged past B flow through the normal live fan-out path in
/// that same hold (the completing sweep) — in seq order, so the boundary
/// is exact and ordered and can neither lose nor duplicate a frame.
/// Retention overrunning the handoff cursor mid-handoff is the plan:146
/// bounded-baseline exit: the exact bounds-carrying gap, then the session
/// COMPLETES AT THE RING FRONT (the retained window swept through the
/// normal live path, the gap recorded) — never a resumption toward an
/// unreachable B.
/// Why a paced tail completed with a recorded gap (round-5 finding 3,
/// diagnostics): `GapCompleted` is produced by two SEMANTICALLY
/// different exits, and every structured log event about one carries
/// this mandatory reason so consumers can filter them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacedGapExitReason {
    /// A GENUINE retention overrun (the plan:146 bounded-baseline
    /// exit): the ring evicted part of the range the handoff still
    /// owed — the lost interval is UNFETCHABLE (sunk as a
    /// `replay_window_exceeded` retention gap).
    RetentionOverrun,
    /// The ordinary fixed-boundary residual exit: the completing chunk
    /// covered B with frames staged past it — the declared interval is
    /// RETAINED and fetchable (sunk as a `handoff_boundary_reached`
    /// delivery gap; the client's checkpoint-cursor repair fetches it).
    HandoffBoundaryResidual,
}

impl PacedGapExitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RetentionOverrun => "retention_overrun",
            Self::HandoffBoundaryResidual => "handoff_boundary_residual",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub enum PacedTailCompletion {
    /// Nothing was staged beyond the cursor within the completion's own
    /// bounds: the deferral cleared, the session is complete.
    CaughtUp,
    /// One budget-bounded page of the staged range was delivered
    /// through the subscriber's sink. The deferral STAYS armed (frames
    /// keep staging, never interleaving with the pages); the caller
    /// advances its cursor and calls again.
    Handoff { end_seq: i64, serialized_bytes: u64 },
    /// The CLEARED verdict: everything staged up to the completing hold
    /// was delivered in that hold — the page/chunk up to the session's
    /// fixed boundary (the drain target or B), plus everything the
    /// producer staged past it through the normal live fan-out path (the
    /// completing sweep) — and the deferral was CLEARED in the same hold.
    /// The hold is the atomic boundary: post-hold ingests fan out
    /// directly (their seqs are past everything delivered), so the
    /// boundary can neither lose nor duplicate a frame. `end_seq` is the
    /// highest delivered seq. Ends the paced session.
    Completed { end_seq: i64, serialized_bytes: u64 },
    /// The FIXED-TARGET HANDOFF (only
    /// [`TerminalRegistry::complete_paced_tail`] reports this): this
    /// call's page covered the FIXED drain target while the producer
    /// staged frames BEYOND it. NO bulk re-fan, NO clear: the deferral
    /// STAYS armed (live ingest keeps staging, so ordering with the
    /// remainder is preserved) and the caller hands the staged post-target
    /// remainder to [`TerminalRegistry::handoff_paced_tail`], which pages
    /// it toward the completion boundary B captured ONCE under THIS hold
    /// (recorded on the subscriber — the ONE sanctioned head read, at
    /// completion start). The caller advances its cursor to `end_seq` and
    /// switches to handoff calls.
    TargetCovered { end_seq: i64, serialized_bytes: u64 },
    /// The plan:146 bounded-baseline exit: retention overran the handoff
    /// cursor mid-handoff (`handoff_paced_tail`) or the completing chunk
    /// covered the fixed boundary with a staged residual
    /// (`complete_at_fixed_boundary`) — see [`PacedGapExitReason`] for the
    /// two producers' semantics. In both shapes the EXACT bounds-carrying
    /// gaps were sunk through the subscriber's sink FIRST (ordered ahead
    /// of everything else), the deferral was CLEARED in the same hold,
    /// and the session COMPLETES with the gap recorded — never a
    /// resumption of the paged handoff toward an unreachable B (a finite
    /// retention window cannot guarantee convergence against indefinitely
    /// faster output production — plan:146). Ends the paced session.
    GapCompleted {
        lost_from: i64,
        lost_to: i64,
        end_seq: i64,
        serialized_bytes: u64,
        /// The mandatory diagnostics discriminator (round-5 finding 3):
        /// which of the two gap exits produced this verdict.
        reason: PacedGapExitReason,
    },
    /// Retention evicted part of the range the DRAIN phase still owes
    /// toward its fixed target — the exact bounds-carrying interval as
    /// [`PacedPage::Expired`]: the caller must emit the retention gap and
    /// continue the drain from the resumed front (the target stays FIXED,
    /// so this continuation is bounded). Only
    /// [`TerminalRegistry::complete_paced_tail`] reports this. A retention
    /// advance must NEVER become a silent forward jump.
    Expired {
        lost_from: i64,
        lost_to: i64,
        resume_from: i64,
        head_seq: i64,
        oldest_retained_seq: i64,
    },
    /// The terminal, this connection's subscriber, or the session's
    /// attach generation is gone — cancel the session; there is no
    /// deferral left for THIS generation to clear (a superseding
    /// generation owns its own).
    Gone,
}

/// One attached connection's subscription to a terminal's live stream.
struct Subscriber {
    /// Where this connection's frames go (its socket, via a tokio mpsc in `freshell-ws`).
    sink: FrameSink,
    /// The connection's active attach correlation id, stamped onto every frame it
    /// receives (`TerminalView#isCurrentAttachMessage` drops unstamped/mismatched
    /// frames — see 3.10). Per-subscriber, so two clients get their OWN id.
    attach_request_id: Option<String>,
    /// `hello.capabilities.terminalOutputBatchV1` for this connection (`ws-handler.ts:1846-1848`,
    /// stored on the attachment `broker.ts:399`). Batch framing is used **only** when
    /// this is set AND `attach_request_id` is present (`broker.ts:1315-1343`); otherwise
    /// the connection receives legacy per-frame `terminal.output` (the T1 default).
    terminal_output_batch_v1: bool,
    /// `hello.capabilities.pacedTerminalReplayV1` for this connection
    /// (responsive-terminal-restore Workstream 1): parked on the subscriber
    /// exactly like `terminal_output_batch_v1`. Gates the registry's paced
    /// page reads — a subscriber that did not negotiate never serves them.
    paced_terminal_replay_v1: bool,
    /// Restore contract (responsive-terminal-restore): while a paced replay
    /// session is active for this (connection, terminal), [`ingest`] does NOT
    /// fan output out to this subscriber — the retained ring IS the staging
    /// and the session's pages deliver the range in seq order. Armed by the
    /// paced attach, cleared ATOMICALLY under the per-terminal lock by the
    /// session's completing verdicts (`complete_paced_tail`'s page that
    /// covers everything staged under its hold; `handoff_paced_tail`'s
    /// completing hold at the FIXED boundary, or its plan:146 ring-front
    /// exit) — the SAME lock hold that delivers everything staged up to the
    /// clear — so the flag-clear boundary can neither lose nor duplicate a
    /// frame: everything appended before the clear is paged, handed off, or
    /// swept by the completing hold's normal-live-path delivery, and
    /// everything appended after it is fanned out directly. The staged
    /// post-target remainder is NEVER bulk-cloned: it flows through the
    /// bounded post-target handoff, one page-budget-sized chunk per lock
    /// hold.
    paced_deferred: bool,
    /// The FIXED completion boundary B (round-4): the head captured ONCE
    /// under the lock hold that covers the drain's fixed target (the
    /// `TargetCovered` verdict — "completion start"). The post-target
    /// handoff ([`TerminalRegistry::handoff_paced_tail`]) pages the
    /// staged window up to B and ONLY B; the field exists so the boundary
    /// survives across the handoff's per-chunk lock holds WITHOUT any
    /// re-read of the terminal's CURRENT head (the recurring moving-head
    /// chase cause). Set exactly once per session (the TargetCovered
    /// hold), consumed by the handoff's completing verdicts, swept with
    /// the subscriber by re-attach/socket close.
    paced_handoff_boundary: Option<i64>,
    /// Round-2 finding F1: the STAGED natural-exit code — set by
    /// `finish_pty_exit` when the terminal exits while this subscriber's
    /// deferral is still armed. The staged exit is NOT sunk then: the
    /// session's drain drives the deferred final output to completion,
    /// and the completing verdict delivers the staged exit in the SAME
    /// lock hold (ordered after the final pages through the same sink)
    /// and retires the subscriber — the client observes final output
    /// THEN exit (plan:190 sequenced exit delivery). Cleared with the
    /// subscriber on delivery, detach, socket close, or supersede.
    paced_exit_pending: Option<i64>,
    /// Round-2 finding F1: the connection's staged-exit notification
    /// hook (see [`PacedAttachOptions::paced_exit_notify`]) — invoked
    /// once, OUTSIDE the terminal lock, at staging time so the ws layer
    /// can move a still-CREDITED session into its exit-drain.
    paced_exit_notify: Option<PacedExitNotify>,
    /// TERM-07 seam: the attach's `maxReplayBytes` request, threaded through
    /// BOTH attach paths and recorded here with NO delivery-behavior change
    /// this increment. The plan's binding rule preserves the field's legacy
    /// serialized-tail-budget meaning and forbids interpreting it under the
    /// paced capability (no newest-tail selection exists until the
    /// validated-baseline/screen-snapshot increment); the paced-start
    /// observability event reports it (from the wire frame, in the ws
    /// layer), and the increment-3 snapshot work consumes this record.
    #[allow(dead_code)]
    // the increment-3 snapshot work reads it; nothing may read it THIS increment
    max_replay_bytes: Option<i64>,
}

/// One retained produced frame plus its persistent barrier classification (the ring's
/// `ReplayFrame` role — `replay-ring.ts:9-20`). The `output` is the canonical
/// (unstamped) `terminal.output` for legacy replay/fan-out; the classification fields
/// feed the `terminal.output.batch` merge for batch-capable subscribers.
#[derive(Clone)]
struct RetainedFrame {
    output: TerminalOutput,
    barrier: bool,
    barrier_reason: Option<BarrierReason>,
    state_before: ScannerState,
    state_after: ScannerState,
}

impl RetainedFrame {
    /// Project to a [`BatchInputFrame`] for the batch builder.
    fn to_batch_input(&self) -> BatchInputFrame {
        BatchInputFrame {
            seq_start: self.output.seq_start,
            seq_end: self.output.seq_end,
            data: self.output.data.clone(),
            bytes: self.output.data.len(),
            stream_id: self.output.stream_id.clone(),
            barrier: self.barrier,
            barrier_reason: self.barrier_reason,
            state_before: self.state_before,
            state_after: self.state_after,
        }
    }
}

/// The per-terminal stream state the reader-thread sink mutates and the registry
/// reads. Split from the PTY handle so the sink can hold an `Arc` to this without
/// owning the PTY (the create-time chicken-and-egg: the PTY is spawned WITH a sink
/// that references this).
struct TerminalShared {
    terminal_id: String,
    stream_id: String,
    /// Every produced frame (with its persistent barrier classification), in seq
    /// order — the authoritative replay buffer (`ReplayRing` role; the PTY's
    /// `OutputFramer` already assigned the seqs). Stored canonical/unstamped; each
    /// delivery stamps per-subscriber and projects to `terminal.output` (legacy) or
    /// `terminal.output.batch` (batch-capable).
    replay: VecDeque<RetainedFrame>,
    /// Total retained scrollback size in **UTF-16 code units**, matching legacy
    /// `ChunkRingBuffer`'s `this.size += chunk.length` accounting (`str.length`
    /// is UTF-16 code units in JS) -- NOT UTF-8 bytes. See [`crate::batch::utf16_len`].
    /// (Named `_chars` rather than `_bytes`: a prior port counted `data.len()`
    /// UTF-8 bytes here, which evicted non-ASCII-heavy content, e.g. box-drawing
    /// TUIs, up to 3x sooner than an ASCII session under the identical configured
    /// `terminal.scrollback` cap. Fixed to count the same unit as legacy.)
    replay_chars: usize,
    /// `settings.terminal.scrollback`, converted to a **char** (UTF-16 code-unit)
    /// cap via [`compute_scrollback_max_bytes`] and captured ONCE at
    /// terminal-creation time (TERM-13). Replaces the previous fixed 8MiB
    /// constant in the eviction loop below.
    ///
    /// NOTE: [`compute_scrollback_max_bytes`] keeps its historical "bytes" name
    /// for public-API stability (`freshell-server`'s boot wiring calls it across
    /// the crate boundary, outside this crate's ownership) despite returning a
    /// CHAR budget -- see that function's doc comment. This field and
    /// `replay_chars` are named honestly since they are private to this module.
    max_replay_chars: usize,
    /// The per-terminal stateful VT [`BarrierScanner`] (`replay-ring.ts:48`). Classifies
    /// each ingested frame in order; its mode/CSI/string state persists across frames.
    scanner: BarrierScanner,
    /// Per-terminal emulator-mode projection ([`ModeTracker`] — mode
    /// replay-sync). Fed the SAME decoded frame data as `scanner` in `ingest`
    /// (never re-decode bytes) and read once per surface-reset `attach` to
    /// synthesize the `terminal.modes.sync` preamble.
    ///
    /// Lifecycle invariant: keyed to this ROW, i.e. effectively
    /// (terminalId, streamId) — the Rust port has no stream-replace lifecycle
    /// (auto-resume spawns a NEW terminal id; a live row's `stream_id` never
    /// mutates), so the tracker dies exactly when the row does
    /// (`kill_internal` is the only row-removal site; `finish_pty_exit`
    /// RETAINS the row and therefore the frozen mode state, which is exactly
    /// what an attach to an exited terminal must sync to render its tail).
    modes: ModeTracker,
    /// Per-terminal repaint-noise fingerprinter feeding the DEV-0009
    /// meaningful clocks (`last_meaningful_activity_at` for the idle reaper,
    /// `last_meaningful_output_at` for the wedge-backstop stuck sweep).
    /// Independent of the barrier
    /// scanner: separate state, separate concern (reaping, not batching).
    noise: NoiseScanner,
    /// Highest `seqEnd` produced (drives `attach.ready.headSeq`).
    head_seq: i64,
    status: TerminalRunStatus,
    /// The exit code from the last `terminal.exit` fan-out (kill or natural exit).
    /// `None` while `status == Running`. Kept so a client that attaches AFTER the
    /// terminal already exited (the create-then-instant-exit race) can still be
    /// told the process is dead instead of silently seeing nothing (DEFECT 5b /
    /// "blank pane" -- see `attach`'s already-exited synthetic-exit branch).
    exit_code: Option<i64>,
    created_at: i64,
    /// Raw MIXED-source activity (epoch ms): refreshed by BOTH PTY output
    /// frames in [`ingest`] AND user keystrokes in [`input`]
    /// (terminal-core.md §1.3 pins the output half for every wire
    /// consumer); stamped once more at `finish_pty_exit`. Wire-visible
    /// via `inventory()`/`DirectoryEntry` — its semantics must not
    /// change. The idle reaper and the stuck sweep deliberately read the
    /// more precise derived clocks below instead of this mixed one.
    last_activity_at: i64,
    /// The wedge-backstop FRESHNESS clock (episode-3 focused review r2,
    /// Finding 1): last RAW PTY OUTPUT — refreshed by EVERY output frame
    /// in [`ingest`], the same write that bumps the wire-visible
    /// `last_activity_at` above. OUTPUT-ONLY: never refreshed by
    /// keystrokes (`input`), the detach/socket-close grace bumps, or
    /// anything else — only a real output stream (a repaint loop) can
    /// keep it fresh. Read by `enforce_stuck_detection`'s
    /// activity-freshness conjunct: reading the MIXED `last_activity_at`
    /// there instead let a single keypress manufacture the wedge
    /// differential on a healthy quiet pane (input refreshes the mixed
    /// raw clock while both output clocks stay stale → a false flag
    /// violating the no-alteration contract).
    last_output_activity_at: i64,
    /// The idle-kill reap clock (DEV-0009): last MEANINGFUL activity — user
    /// input, or PTY output carrying genuinely new content per
    /// [`NoiseScanner`]. Unlike `last_activity_at` (wire-visible via
    /// `inventory()`/`DirectoryEntry` and spec-pinned to bump on EVERY
    /// output frame, terminal-core.md §1.3), repaint noise (spinner frames,
    /// ticking counters, status-bar redraws) does not refresh this.
    /// Read by `enforce_idle_kills` (idle reaping) ONLY — the stuck sweep
    /// reads the output-only clocks
    /// ([`TerminalShared::last_output_activity_at`] and the grace-immune
    /// [`TerminalShared::last_meaningful_output_at`]) instead.
    /// The last-subscriber teardown grace bumps (`detach`,
    /// `remove_connection`) deliberately refresh THIS clock so a freshly
    /// backgrounded terminal gets a full idle threshold of reap grace.
    last_meaningful_activity_at: i64,
    /// The wedge-backstop clock (delta-review round 4, Finding 1): last
    /// MEANINGFUL PTY OUTPUT — refreshed ONLY by genuinely-new content as
    /// classified by [`NoiseScanner::observe`] in `ingest`. NEVER by
    /// keystrokes (`input`), the detach/socket-close grace bumps, or
    /// anything else: the wedge signal is the classifier's judgment of the
    /// pane's OUTPUT, so typing at / Ctrl+C-ing a genuinely wedged pane
    /// (the natural first response) does not clear or postpone the stuck
    /// state (a healthy engaged pane's keystroke echo arrives via `ingest`
    /// and keeps this clock fresh through output anyway), and a page
    /// refresh must not reset wedge detection either (the grace bumps exist
    /// for the idle reaper's threshold only, and a page refresh is exactly
    /// what a user performs on a stuck UI). Read by
    /// `enforce_stuck_detection`'s staleness conjunct (the wedge
    /// differential's meaningful half; the freshness half is the raw
    /// output-only [`TerminalShared::last_output_activity_at`]).
    last_meaningful_output_at: i64,
    /// Set (epoch ms) while `enforce_stuck_detection` flags this row stuck;
    /// cleared by the first meaningful output. Surface-only state.
    stuck_since: Option<i64>,
    /// Current PTY geometry + epoch (`§5.3`): epoch starts 1, +1 only on a real change after the first client geometry record.
    cols: u16,
    rows: u16,
    geometry_epoch: i64,
    /// TERM-07 parity with Node's `hasPreviousGeometry` (`broker.ts:666-686`):
    /// false until the first client-supplied geometry is recorded. The first
    /// record applies dims WITHOUT bumping `geometry_epoch` (spawn defaults
    /// never count as a prior record); later real changes bump.
    has_client_geometry: bool,
    cwd: Option<String>,
    /// Directory metadata (`terminal-registry.ts:1614` stores `getModeLabel(opts.mode)`
    /// as the title at create; `getModeLabel('shell') === 'Shell'`). Defaults preserve
    /// the pre-meta behavior for the shell-only create path; `set_meta` (called from
    /// the WS `terminal.create` handler once CLI panes land) overrides per-mode.
    title: String,
    description: Option<String>,
    /// `TerminalMode` (`'shell' | 'claude' | 'codex' | …`).
    mode: String,
    /// The session id a CLI pane resumed from (feeds the directory `sessionRef`).
    resume_session_id: Option<String>,
    /// The pane's stable creation key (`terminal.create.requestId`), stamped
    /// ATOMICALLY with the registry insert — it is a field of the inserted row,
    /// so no observer can ever see a row without its key (reconciliation
    /// handshake design §5.1). `None` for creates that carried no key (e.g.
    /// REST ingress, which mints none — design §5.5 precondition 2).
    create_request_id: Option<String>,
    /// Attached connections, keyed by connection id (multi-client fan-out, `§7.3`).
    subscribers: HashMap<u64, Subscriber>,
    /// Connections claiming this terminal's LIFETIME (responsive-terminal-
    /// restore Workstream 1) without attaching — negotiated hidden panes.
    /// Membership is per-connection and sweeps away with the socket
    /// (`remove_connection`); a dropped claimer does NOT restore
    /// `released_by_client` (transport loss is not release — identical to a
    /// dropped subscriber). Only an explicit withdrawal
    /// ([`TerminalRegistry::withdraw_claim`]) of the LAST claim (with no
    /// subscribers) re-marks the row released, mirroring detach's
    /// last-reference logic.
    claims: BTreeSet<u64>,
    /// Whether the client EXPLICITLY released its last reference to this
    /// terminal (`terminal.detach` emptying `subscribers`) — as opposed to
    /// merely losing its socket (`remove_connection`: browser closed, laptop
    /// asleep, network drop). The client's detach reconciler
    /// (`src/store/terminalDetachMiddleware.ts`) sends `terminal.detach` only
    /// when a terminal disappears from EVERY pane layout, so an explicit
    /// detach means "orphaned — nobody wants this anymore" while a
    /// connection drop means "detached but still wanted" (the tmux-style
    /// background-session promise, §1.3). `enforce_idle_kills` reaps
    /// released terminals at the configured threshold (legacy cleanup) but
    /// grants un-released ones the 24h hard cap instead of silently
    /// SIGKILLing a wanted background shell after ~15 idle minutes.
    /// Starts `true` (a never-attached row keeps legacy fast-reap
    /// eligibility); any successful attach flips it `false`.
    released_by_client: bool,
    /// Unified agent names (Task 2): the naming identity this terminal's
    /// saved name resolves through (pending handle before verified
    /// materialization, durable provider/session ref after). Retained on
    /// the registry row so every inventory/projection reader can carry it
    /// without a round-trip through the identity registry. `None` for
    /// terminals outside the six unified modes.
    name_ref: Option<freshell_protocol::session_names::SessionNameRef>,
    /// Unified agent names: the pre-durable naming handle retained beside
    /// `name_ref` (the durability-driven bind lanes read it after a
    /// restart-remint of the createRequestId).
    naming_handle: Option<String>,
    /// Unified agent names: the last-known canonical name record (a display
    /// cache ONLY — never an accepted name input; the `session.name.updated`
    /// broadcast and store reads are the authority). Updated by the naming
    /// publisher on every committed change and at scoped create.
    session_name: Option<freshell_protocol::session_names::SessionNameRecord>,
}

impl TerminalShared {
    /// The earliest sequence position still available for replay (restore
    /// contract, responsive-terminal-restore): the retained ring's front
    /// `seqStart`, or `head_seq + 1` when the ring is empty (nothing older
    /// than the head is retained). Caller holds the terminal lock.
    fn oldest_retained_seq(&self) -> i64 {
        self.replay
            .front()
            .map(|f| f.output.seq_start)
            .unwrap_or(self.head_seq + 1)
    }

    /// `single_client` while at most one socket is attached; `multi_client_unknown`
    /// once a second attaches (`§5.3`, `broker.ts:394-395`). The client uses this to
    /// decide checkpoint/delta-replay validity, so it must reflect reality.
    fn geometry_authority(&self) -> GeometryAuthority {
        if self.subscribers.len() >= 2 {
            GeometryAuthority::MultiClientUnknown
        } else {
            GeometryAuthority::SingleClient
        }
    }

    /// This terminal's `terminal.inventory` row (`registry.list()` →
    /// `normalizeTerminalInventoryForClient`, `terminal-registry.ts:4250-4263`). The
    /// SPA reads `terminalId` + `status==='running'` to keep a persisted terminal
    /// (else `clearDeadTerminals` recreates it, losing scrollback).
    fn inventory(&self) -> InventoryTerminal {
        InventoryTerminal {
            created_at: self.created_at,
            last_activity_at: self.last_activity_at,
            mode: self.mode.clone(),
            status: self.status,
            terminal_id: self.terminal_id.clone(),
            title: self.title.clone(),
            codex_durability: None,
            cwd: self.cwd.clone(),
            description: self.description.clone(),
            runtime_status: None,
            session_ref: None,
            session_name: self.session_name.clone(),
            name_ref: self.name_ref.clone(),
        }
    }
}

/// One terminal's row for the identity-invariant sweep
/// ([`TerminalRegistry::identity_probe_rows`]): the identity-relevant fields
/// only — deliberately NO scrollback snapshot (unlike [`DirectoryEntry`]), so
/// a periodic sweep stays cheap.
#[derive(Debug, Clone)]
pub struct IdentityProbeRow {
    pub terminal_id: String,
    pub mode: String,
    pub status: TerminalRunStatus,
    pub created_at: i64,
    /// The registry-side resume/session id (create-time resume OR a locator
    /// association written back via `set_meta`) — a terminal with this set is
    /// identity-resolved even if the caller's identity registry has no entry
    /// (e.g. REST-created resumes, whose creates can't reach the WS-owned
    /// identity registry across the crate boundary).
    pub resume_session_id: Option<String>,
    /// The terminal's working directory — carried so the §5.4 adopt branch can
    /// echo the EXISTING terminal's cwd on its `terminal.created` frame.
    pub cwd: Option<String>,
}

/// One terminal's row for the REST terminal directory (`registry.list()` as consumed
/// by `terminal-view/service.ts#listTerminalDirectory`): the raw registry record the
/// `/api/terminals` router projects into the wire `TerminalDirectoryItem` (override
/// merge, `sessionRef` derivation, and `lastLine` extraction happen in the router).
#[derive(Debug, Clone)]
pub struct DirectoryEntry {
    pub terminal_id: String,
    pub title: String,
    pub description: Option<String>,
    pub mode: String,
    pub resume_session_id: Option<String>,
    pub created_at: i64,
    pub last_activity_at: i64,
    pub status: TerminalRunStatus,
    /// `clients.size > 0` — whether any connection is currently attached.
    pub has_clients: bool,
    pub cwd: Option<String>,
    /// The retained scrollback reassembled in seq order (the original's
    /// `record.buffer.snapshot()` — both sides are byte-capped rings, so this is
    /// the same tail the original's `lastEmittedLine` reads).
    pub snapshot: String,
    /// Unified agent names (Task 2): the terminal's naming binding (pending
    /// handle before verified materialization, durable provider/session ref
    /// after) — additive on the `/api/terminals` row so readers carry the
    /// same identity the rename routes target. `None` for terminals outside
    /// the six unified modes.
    pub name_ref: Option<freshell_protocol::session_names::SessionNameRef>,
    /// Unified agent names: the last-known canonical name record (a display
    /// cache only — the store and its `session.name.updated` broadcasts are
    /// the authority). `None` until the naming publisher or a scoped create
    /// stamps it.
    pub session_name: Option<freshell_protocol::session_names::SessionNameRecord>,
}

/// Durable identity of a terminal whose OS process is owned by the external
/// managed-runtime supervisor/session-host rather than this web-server process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedTerminalDescriptor {
    pub soul_id: String,
    pub incarnation_id: String,
    pub terminal_id: String,
    pub stream_id: String,
    pub mode: String,
    pub cwd: String,
    pub resume_session_id: Option<String>,
    pub create_request_id: Option<String>,
}

/// Launch request handed across the terminal crate's transport-agnostic seam.
/// The controller is responsible for turning this already-resolved SpawnSpec into
/// one supervisor-owned session-host workload; it must never respawn locally.
#[derive(Debug, Clone)]
pub struct ManagedTerminalLaunch {
    pub spec: SpawnSpec,
    pub env: BTreeMap<String, String>,
    pub terminal_id: String,
    pub stream_id: String,
    pub mode: String,
    pub resume_session_id: Option<String>,
    pub provider_model: Option<String>,
    pub provider_reasoning_effort: Option<String>,
    pub provider_sandbox: Option<String>,
    pub provider_permission_mode: Option<String>,
    pub view_tab_id: Option<String>,
    pub view_pane_id: Option<String>,
    pub create_request_id: Option<String>,
}

pub type ManagedTerminalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedOutputChunk {
    pub seq_start: i64,
    pub seq_end: i64,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedOutputRead {
    /// The session host's durable output epoch, not the web's launch-time ID.
    /// None denotes a coalesced/in-flight read with no source observation.
    pub stream_epoch: Option<String>,
    pub incarnation_id: Option<String>,
    pub reset_required: bool,
    pub truncated: bool,
    pub retained_from_seq: i64,
    pub head_seq: i64,
    pub exit_code: Option<i64>,
    pub native_session_id: Option<String>,
    pub chunks: Vec<ManagedOutputChunk>,
}

/// Async control seam implemented by `freshell-server` with
/// `freshell-runtime-client`. Keeping the trait here lets the existing registry
/// remain the browser-facing replay/fan-out owner while the web server has no PTY,
/// PID, Docker socket, or direct kill authority for managed rows.
pub trait ManagedTerminalController: Send + Sync {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        create_request_id: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>>;
    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, String>>;
    fn input<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        data: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>>;
    fn resize<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        cols: u16,
        rows: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>>;
    fn stop<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>>;
    fn read_output<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        after_seq: i64,
        max_bytes: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>>;
}

/// The registry's control handle for one terminal: the shared stream state plus the
/// PTY (for input/resize/kill). `pty` is `Option` so tests can register a headless
/// terminal and drive the stream logic deterministically without a real child.
struct TerminalHandle {
    shared: Arc<Mutex<TerminalShared>>,
    pty: Option<PtyTerminal>,
    managed: Option<ManagedTerminalDescriptor>,
    managed_read_in_flight: Arc<AtomicBool>,
}

/// A nonblocking per-facade claim. Coalescing refreshes prevents a slow old
/// epoch read from applying after a new epoch. Drop also releases the claim
/// when a websocket timeout cancels the RPC; no executor dependency is needed.
struct ManagedReadClaim(Arc<AtomicBool>);
impl ManagedReadClaim {
    fn acquire(flag: Arc<AtomicBool>) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag))
    }
}
impl Drop for ManagedReadClaim {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Registration options for a terminal record with NO backing PTY.
///
/// This is the registry's headless seam (reconciliation-handshake design §9.1:
/// "the registry supports headless terminals for exactly this"): crate tests —
/// including `freshell-ws`'s wire-level reconcile tests, which sit across the
/// crate boundary and cannot reach the private [`TerminalShared`] — seed
/// live/exited terminal generations deterministically without spawning real
/// children. Never called on a production path (production terminals are only
/// ever registered by [`TerminalRegistry::create`], which spawns the PTY).
#[derive(Debug, Clone, Default)]
pub struct HeadlessTerminal {
    pub terminal_id: String,
    pub stream_id: String,
    /// `TerminalMode` string; empty is normalized to `"shell"`.
    pub mode: String,
    pub resume_session_id: Option<String>,
    /// The pane's stable creation key (see [`TerminalRegistry::create`]).
    pub create_request_id: Option<String>,
    /// Explicit creation timestamp (epoch ms); `None` = now.
    pub created_at: Option<i64>,
}

struct RegistryInner {
    terminals: HashMap<String, TerminalHandle>,
    /// Run-monotonic inventory revision (`terminals.changed.revision`, `§7.5`). Only
    /// its monotonic increase is asserted by the oracle, not the value.
    revision: i64,
    /// Respawn-generation counters per `createRequestId` (reconciliation design
    /// §7.5): consecutive generations that exited WITHIN the liveness window.
    /// Reset to 0 whenever a generation survives the window. Read by
    /// [`TerminalRegistry::respawn_exhausted`], which turns an infinite
    /// respawn ↔ instant-exit loop into a terminal `dead_session` verdict.
    respawn_generations: HashMap<String, u32>,
}

/// Shared, cheaply-cloneable owner of all live terminals, keyed by `terminalId`.
/// Lives in `WsState` so every `/ws` connection resolves terminals through the SAME
/// registry — the whole point: a terminal survives its creating socket.
/// `settings.safety.autoKillIdleMinutes` default (`server/settings.ts:791`,
/// mirrored at `crates/freshell-server/src/settings.rs:70`). Applied whenever
/// a [`TerminalRegistry`] is constructed but `set_auto_kill_idle_minutes`
/// hasn't been called yet (e.g. before the boot-time settings load completes).
const DEFAULT_AUTO_KILL_IDLE_MINUTES: i64 = 15;

/// Stuck-pane detection window: an agent-mode terminal whose PTY produced no
/// MEANINGFUL output for this long is flagged `stuck` — surfaced to the pane
/// as the "Agent appears stuck" card, NEVER auto-killed. Attached panes are
/// the primary class (the idle reaper deliberately exempts them,
/// registry.rs `enforce_idle_kills`) — this sweep has NO subscribers
/// exemption. The terminal-mode analogue of the freshcodex quiet deadman
/// (`FRESHELL_FRESHCODEX_QUIET_WINDOW_MS`, codex.rs) but keyed on the
/// DEV-0009 meaningful clock because a wedged agent TUI (e.g. opencode
/// resumed onto an aborted session rendering an eternal spinner) keeps
/// repainting: only the noise classifier distinguishes it from progress.
/// 2h default: far above normal long-turn/LLM-thinking silence, well below
/// the observed 2-day zombie. Seeded from FRESHELL_TERMINAL_STUCK_WINDOW_MS
/// by freshell-server main; 0/negative disables.
pub const DEFAULT_STUCK_WINDOW_MS: i64 = 7_200_000;

/// How recent raw PTY output must be for a row to count as "still
/// repainting". 5 minutes: far above the 30s sweep tick, generous to any
/// degraded repaint cadence, and hours below the 2h meaningful-silence
/// window — so the two conjuncts never fight on real wedges.
pub const STUCK_ACTIVITY_FRESH_MS: i64 = 300_000;

/// TERM-15/TERM-16 activity tap: the registry-level lifecycle events the
/// activity hub (`freshell-ws`) subscribes to. `Created`/`Exit` fire for
/// every mode; `Input`/`Output` fire only for CLI modes (`mode != "shell"`)
/// so plain shells pay zero per-chunk tap cost. The observer runs on the
/// caller's thread (`Created`/`Input`/kill-`Exit`) or the PTY reader thread
/// (`Output`/natural-exit `Exit`) — it must be cheap and non-blocking.
#[derive(Debug, Clone, PartialEq)]
pub enum ActivityEvent {
    Created {
        terminal_id: String,
        mode: String,
        resume_session_id: Option<String>,
        at: i64,
    },
    Input {
        terminal_id: String,
        data: String,
        at: i64,
    },
    Output {
        terminal_id: String,
        data: String,
        at: i64,
    },
    Exit {
        terminal_id: String,
        at: i64,
        /// true = the process died on its own (finish_pty_exit); false = a
        /// freshell-initiated kill (api / idle reaper / shutdown). Human-requested
        /// closes must never ring the attention bell.
        spontaneous: bool,
    },
}

/// The activity tap callback (see [`ActivityEvent`]).
pub type ActivityObserver = Arc<dyn Fn(ActivityEvent) + Send + Sync>;

/// Reconciliation §7.5 defaults: a resumed CLI that exits within 30s of
/// spawn, 3 generations in a row, is a respawn ↔ instant-exit loop.
const DEFAULT_RESPAWN_LIVENESS_WINDOW_MS: i64 = 30_000;
const DEFAULT_RESPAWN_GENERATION_CAP: i64 = 3;

/// Explicit wall-clock backstop for a hung holder. NOT derived from any
/// "spawn budget" — the 10s constant at create_limit.rs:49 (spawn_timeout_ms,
/// env FRESHELL_SPAWN_GATE_TIMEOUT_MS) bounds the spawn-GATE PERMIT wait,
/// not spawn duration; spawns run unbounded in spawn_blocking. Task 6 makes
/// this env-tunable and adds spawn-duration instrumentation to tune it on
/// evidence.
pub const SESSION_REF_LEASE_TTL_MS: u64 = 20_000;
pub const SESSION_RESERVED_RETRY_AFTER_MS: u64 = 1_000;

/// The effective lease TTL: `FRESHELL_SESSION_REF_LEASE_TTL_MS` when set to a
/// positive integer, else [`SESSION_REF_LEASE_TTL_MS`]. Same sanitizing-parse
/// shape as the spawn-gate timeout's `FRESHELL_SPAWN_GATE_TIMEOUT_MS`
/// (`freshell-ws/src/create_limit.rs`) — unset/unparseable/zero → default.
/// Kept next to the const so the client's re-drive window derivation
/// (Task 12: window > TTL + margin) stays visible in one place.
pub fn session_ref_lease_ttl_ms() -> u64 {
    std::env::var("FRESHELL_SESSION_REF_LEASE_TTL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(SESSION_REF_LEASE_TTL_MS)
}

/// Whether `pid` is still alive (`kill(pid, 0)`): the ESRCH death-confirm
/// probe of the kill-before-release discipline (council rule 8). Only ESRCH
/// confirms death — EPERM (or any other errno) reports ALIVE, so an
/// uncertain probe can never release a lease it shouldn't. Non-unix: PTY
/// pids are never recorded there ([`crate::pty::PtyTerminal::pid`] is
/// `None`), so no pid-carrying lease can exist and this is unreachable.
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 performs existence/permission checking only; no
        // signal is delivered.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Outcome of [`TerminalRegistry::claim_session_ref`] (council rule 7, D8:
/// one in-flight create per sessionRef, liveness-bound).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionRefClaim {
    Acquired,
    Held {
        retry_after_ms: u64,
    },
    /// TTL expired on a holder with a recorded child: caller must kill the
    /// holder's spawn via the REGISTRY handle (group-kill discipline,
    /// pty.rs:352-386 — never a raw single-pid SIGKILL), CONFIRM death, then
    /// call force_release_after_confirmed_kill and re-claim. The pid is for
    /// ESRCH-confirmation, not for raw kill().
    ExpiredNeedsKill {
        pid: u32,
    },
    BoundElsewhere {
        terminal_id: String,
    },
}

/// One in-flight sessionRef create reservation (value side of
/// `TerminalRegistry::session_ref_leases`, keyed `"provider\u{0}sessionId"`).
/// Released on spawn complete (bind), spawn fail (error), or holder
/// connection death; [`SESSION_REF_LEASE_TTL_MS`] is the wall-clock backstop
/// for a hung holder — expiry is KILL-BEFORE-RELEASE (a pid-carrying lease
/// stays held until the caller confirms the kill; a pid-less one is revoked
/// and held closed, never released except via holder conn death or spawn
/// failure, both of which prove no orphan child exists).
#[derive(Debug, Clone)]
struct SessionRefLease {
    /// Stored alongside the string key so conn-death cleanup can hand
    /// callers real [`SessionLocator`]s without parsing NUL-joined keys.
    locator: SessionLocator,
    holder_create_request_id: String,
    holder_conn: u64,
    acquired_at_ms: u64,
    /// The spawned child's pid once the holder records it
    /// ([`TerminalRegistry::set_session_ref_lease_pid`]) — presence decides
    /// TTL expiry's shape (`ExpiredNeedsKill` vs revoke-and-hold-closed).
    pid: Option<u32>,
    /// Set when TTL expired on a pid-less holder: there is nothing to kill,
    /// so the lease is held closed and the holder's late
    /// [`TerminalRegistry::complete_session_ref_claim`] is rejected.
    revoked: bool,
}

/// A sessionRef lease's map key: `"provider\u{0}sessionId"` (NUL joint —
/// neither side can contain it, so the key is collision-free).
fn session_ref_key(locator: &SessionLocator) -> String {
    format!("{}\u{0}{}", locator.provider, locator.session_id)
}

/// The runtime identity a retained claim commits/releases under (kata b8ke
/// Task 4): terminal kind, the terminal id, the recorded pid, keyed to the
/// committing operation (the release fence key).
fn retained_runtime_identity(
    claim: &RetainedSessionRefOwnership,
) -> freshell_ownership::OwnerIdentity {
    freshell_ownership::OwnerIdentity {
        kind: freshell_ownership::RuntimeOwnerKind::Terminal,
        terminal_id: Some(claim.terminal_id.clone()),
        live_session_key: None,
        pid: claim.pid,
        ownership_id: Some(claim.operation_id.clone()),
    }
}

/// kata b8ke Task 7: the terminal-create pause hook — a closure returning a
/// future the WS lane's `handle_create` AWAITS (parked between the
/// keyed-create precheck and the coordinator claim). Test-only (never set in
/// production); the `TerminalLivenessProbe` injection idiom, async flavor —
/// this std-sync-free crate only STORES the future, the WS lane awaits it.
pub type TerminalCreatePauseHook = std::sync::Arc<
    dyn Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync,
>;

/// b8ke ext r39 F1: the identity re-adopt PRE-ARM pause hook — the
/// deterministic-race tests park `coordinator_begin_identity`'s re-adopt
/// arm between the precheck observation and the atomic adopt (the
/// vulnerable interval the post-arm pauses cannot reach), to prove a
/// completed cross-kind handoff in that interval answers the typed
/// refusal instead of arming the guard on the new owner. Keyed
/// `(provider, session_id)`. Interior-shared like the create seam. Never
/// set in production.
pub type IdentityReadoptPauseHook = std::sync::Arc<
    dyn Fn(&str, &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct TerminalRegistry {
    inner: Arc<Mutex<RegistryInner>>,
    conn_seq: Arc<AtomicU64>,
    /// DIAG-05: a LIVE count of currently-open `/ws` connections (distinct
    /// from `conn_seq`, which is a monotonic minting counter that never goes
    /// down). Incremented in [`Self::new_connection_id`] (called once per
    /// connection establish, `freshell_ws::terminal::run`), decremented in
    /// [`Self::remove_connection`] (called once per connection close, same
    /// call site) -- both call sites already exist and are unchanged; only
    /// their bodies gained this counter. Surfaced via [`Self::connection_count`]
    /// as `GET /api/debug`'s `wsConnections` (legacy
    /// `wsHandler.connectionCount()`, `server/debug-router.ts:16`).
    active_connections: Arc<AtomicI64>,
    /// `this.settings.safety.autoKillIdleMinutes` (`terminal-registry.ts:1409`,
    /// read fresh on every sweep tick from `this.settings`, which `setSettings`
    /// keeps current). Stored as an atomic so `enforce_idle_kills` never needs
    /// the registry lock just to read the threshold, and so a live settings
    /// change (`set_auto_kill_idle_minutes`) is visible on the NEXT sweep
    /// without restarting the monitor.
    auto_kill_idle_minutes: Arc<AtomicI64>,
    /// Wedge-backstop: the `enforce_stuck_detection` meaningful-idle window
    /// (ms; [`DEFAULT_STUCK_WINDOW_MS`] is the default). Atomic like
    /// `auto_kill_idle_minutes` so the sweep reads the live value without
    /// the registry lock, and a live change ([`Self::set_stuck_window_ms`])
    /// is visible on the NEXT sweep without restarting the monitor.
    /// `0`/negative disables the sweep.
    stuck_window_ms: Arc<AtomicI64>,
    /// `this.scrollbackMaxChars` (`terminal-registry.ts:1276`, computed by
    /// `computeScrollbackMaxChars` from `settings.terminal.scrollback`).
    /// Captured into each new terminal's `max_replay_chars` at [`Self::create`]
    /// time (TERM-13) -- see [`compute_scrollback_max_bytes`].
    scrollback_max_bytes: Arc<AtomicI64>,
    /// Responsive-terminal-restore Workstream 1: the serialized-byte budget
    /// of ONE paced replay page ([`DEFAULT_PACED_PAGE_MAX_BYTES`]). Atomic so
    /// focused tests shrink it per-instance without env races.
    paced_page_max_bytes: Arc<AtomicI64>,
    /// TERM-15/TERM-16 activity tap (see [`ActivityEvent`]). Set once at boot
    /// by the activity hub; `None` (the default) keeps every fire point a
    /// cheap no-op. RwLock: read per event, written once.
    activity_observer: Arc<std::sync::RwLock<Option<ActivityObserver>>>,
    /// Reconciliation §7.5: a generation that exits within this window of its
    /// creation counts toward the respawn cap; one that survives it resets the
    /// counter. Atomic (mirrors `auto_kill_idle_minutes`) so tests can shrink
    /// it without sleeping.
    respawn_liveness_window_ms: Arc<AtomicI64>,
    /// Reconciliation §7.5: consecutive short-lived generations after which
    /// [`Self::respawn_exhausted`] fires.
    respawn_generation_cap: Arc<AtomicI64>,
    /// §5.4 single-flight: `createRequestId`s with a keyed create currently
    /// in flight (claimed before the spawn, released after the insert). The
    /// spawn takes milliseconds and the row only becomes observable at
    /// insert, so without this reservation two truly concurrent creates for
    /// one key could BOTH pass the `newest_live_by_create_request_id` check
    /// and both spawn — the exact duplicate-writer shape the dedupe closes.
    keyed_create_inflight: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Same-id double-resume guard (amplifier identity plan, F5/V7): resume
    /// ids with an amplifier create currently in flight, keyed
    /// `"resume:{mode}:{sid}"`. A SIBLING of `keyed_create_inflight`
    /// (identical claim-before-spawn / release-after-insert semantics — the
    /// §5.4 TOCTOU doc applies verbatim), deliberately NOT the same set: WS
    /// `handle_create` claims client-supplied `createRequestId`s in
    /// `keyed_create_inflight` itself, so a client could send a requestId
    /// shaped `resume:amplifier:<sid>` and collide with the guard's keys.
    resume_create_inflight: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Council rule 7 (D8): one in-flight create per sessionRef. Keyed
    /// `"provider\u{0}sessionId"` ([`session_ref_key`]); see
    /// [`SessionRefLease`] for the release/TTL/kill-before-release rules.
    /// Mirrors the `keyed_create_inflight` shape (claim before spawn,
    /// release after bind/fail/conn-death).
    session_ref_leases: Arc<Mutex<HashMap<String, SessionRefLease>>>,
    /// locator key ([`session_ref_key`]) → the terminalId a completed claim
    /// bound the sessionRef to. Consulted by
    /// [`Self::claim_session_ref`] alongside
    /// [`Self::live_terminal_for_session_ref`]; a binding whose terminal is
    /// KNOWN dead (registered but not Running) is pruned instead of
    /// answering `BoundElsewhere`, so a dead winner never strands losers.
    session_ref_bindings: Arc<Mutex<HashMap<String, String>>>,
    /// Installed only when the Rust server opts into the managed runtime.
    managed_controller: Arc<std::sync::RwLock<Option<Arc<dyn ManagedTerminalController>>>>,
    /// Connections that negotiated the additive `managedRuntimeV1` capability.
    managed_runtime_connections: Arc<Mutex<std::collections::HashSet<u64>>>,
    /// kata b8ke Task 4: the ONE server-wide runtime-ownership coordinator,
    /// release-only integration (the registry itself never claims — the WS/
    /// REST/auto-resume lanes claim; this crate only RELEASES on confirmed
    /// death: `kill_internal`'s end-of-fn release after the PTY kill, the
    /// natural-exit release in `finish_pty_exit`, and the force-release twin
    /// beside [`Self::force_release_after_confirmed_kill`]). `None` (every
    /// pre-existing construction) keeps all of it a no-op.
    ownership: Option<Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
    /// kata b8ke Task 4: the retained coordinator commit per sessionRef key —
    /// the fenced `ReleaseClaim` source for the exit/kill release paths. A
    /// terminal that committed `Live{Terminal}` through
    /// [`Self::commit_session_ref_ownership`] records its claim here; the
    /// release paths take-if-matches (a newer owner's entry is never taken by
    /// an older terminal's exit).
    session_ref_ownership: Arc<Mutex<HashMap<String, RetainedSessionRefOwnership>>>,
    /// kata b8ke Task 7: the deterministic-race pause seam for
    /// `terminal.create` — a closure returning a future the WS lane's
    /// `handle_create` AWAITS between the keyed-create precheck and the
    /// coordinator claim, so tests can park a create mid-flight and prove the
    /// cross-kind fencing under a concurrent fresh-agent attach (a
    /// notify-only closure would not pause anything). `None` (the default,
    /// never set in production) keeps every create a no-op pass-through.
    /// Hosted HERE (not on the WS state struct) because the registry is the
    /// terminal lane's shared, constructor-built state — interior-shared so
    /// every cloned handle (the WS state's, the REST spawn state's) observes
    /// a test-set hook (the `activity_observer` injection idiom).
    terminal_create_pause: Arc<std::sync::RwLock<Option<TerminalCreatePauseHook>>>,
    /// b8ke ext r12 F2: the ATTACH-path park seam (see
    /// [`Self::set_terminal_attach_pause_for_tests`]). Never set in
    /// production.
    terminal_attach_pause: Arc<std::sync::RwLock<Option<TerminalCreatePauseHook>>>,
    /// b8ke ext r39 F1: the identity re-adopt PRE-ARM pause hook (see
    /// [`IdentityReadoptPauseHook`]). Never set in production.
    identity_readopt_pause: Arc<std::sync::RwLock<Option<IdentityReadoptPauseHook>>>,
    /// b8ke ext r13 F1: the create POST-CLAIM park seam (see
    /// [`Self::set_terminal_create_postclaim_pause_for_tests`]). Never
    /// set in production.
    terminal_create_postclaim_pause: Arc<std::sync::RwLock<Option<TerminalCreatePauseHook>>>,
    /// E2R3 (the atomic exit-transition decision) test-support: the
    /// ONE-SHOT deterministic natural-exit staging hook. A hook site —
    /// a staged-exit read on the transition-decision path — fires it
    /// INSIDE its own terminal-lock hold, immediately AFTER its read
    /// completes, and the registry then performs the natural-exit
    /// STAGING for the armed (connection, code): the deterministic
    /// model of the PTY reader staging its terminal's exit
    /// CONCURRENTLY with the decision's use of its read (never a
    /// sleep-based race). `None` (the default, never armed in
    /// production) keeps every hook site a cheap no-op. Hosted here
    /// (the `terminal_create_pause` idiom) so every cloned handle
    /// observes a test-armed hook.
    paced_exit_stage_hook: Arc<Mutex<Option<PacedExitStageHook>>>,
}

/// The retained coordinator claim for one sessionRef-owning terminal (kata
/// b8ke Task 4): everything the fenced release needs — the locator, the
/// committing operation, its generation, and the runtime identity the commit
/// stamped (terminal id + pid).
#[derive(Debug, Clone)]
pub struct RetainedSessionRefOwnership {
    pub locator: SessionLocator,
    pub terminal_id: String,
    pub operation_id: String,
    pub generation: u64,
    pub pid: Option<u32>,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Outcome of an [`TerminalRegistry::attach`]: whether the terminal existed (the
/// `attach.ready` + replay were enqueued to the caller's sink) — `false` draws the
/// reference's `INVALID_TERMINAL_ID` reply (attach to an unknown terminal; an
/// exited-but-still-registered terminal is `found: true` + a synthetic exit).
#[derive(Debug, Clone, PartialEq)]
#[must_use]
pub struct AttachOutcome {
    pub found: bool,
    /// The attach-time geometry decision when the caller used
    /// [`TerminalRegistry::attach_with_geometry`]. Plain [`TerminalRegistry::attach`]
    /// has no geometry input and returns `None`.
    pub geometry: Option<AttachResizeStatus>,
    /// A negotiated (pacedTerminalReplayV1 + attachRequestId) attach to a
    /// RUNNING terminal: the paced session start — the first page's wire
    /// messages plus the session description — INSTEAD of an inline replay
    /// burst. `None` on every legacy path (non-negotiated, missing
    /// attachRequestId, already-exited terminal).
    pub paced: Option<PacedAttachStart>,
}

/// Outcome of [`TerminalRegistry::input`]: whether the terminal existed (the
/// bytes were written to its PTY when one is attached; headless terminals
/// still count as found and take the activity bump). `false` mirrors the
/// reference's unknown-id input reply (`server/ws-handler.ts:2991-3002`) —
/// the WS layer answers `terminal.input.blocked{reason:unknown_terminal}`,
/// the REST send-keys path logs a warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub struct InputOutcome {
    pub found: bool,
}

/// One [`TerminalRegistry::enforce_stuck_detection`] state change: the
/// terminal, its mode, the new stuck flag, and the sweep instant.
/// Transitions are emitted ONLY on a false→true or true→false edge — never
/// per sweep tick.
#[derive(Debug, Clone, PartialEq)]
pub struct StuckTransition {
    pub terminal_id: String,
    pub mode: String,
    pub stuck: bool,
    pub at: i64,
}

/// Why [`TerminalRegistry::enforce_stuck_detection`] cleared a stuck flag —
/// computed at predicate time (under the row lock, the same instant the
/// flag flips) so the deferred log names the cause that actually fired
/// instead of always claiming a meaningful-activity resume (delta-review
/// round 3). Not part of the `StuckTransition` payload — log accuracy only.
#[derive(Clone, Copy, Debug)]
enum StuckClearCause {
    MeaningfulActivityResumed,
    RepaintOutputStopped,
    TerminalNotRunning,
    /// `set_meta` permits demoting a live row's mode; no production caller
    /// does (association stamps agent modes ONTO rows), but the label stays
    /// honest rather than guessing a clock cause.
    ModeNoLongerAgent,
}

impl StuckClearCause {
    fn reason(&self) -> &'static str {
        match self {
            Self::MeaningfulActivityResumed => "meaningful-activity-resumed",
            Self::RepaintOutputStopped => "repaint-output-stopped",
            Self::TerminalNotRunning => "terminal-not-running",
            Self::ModeNoLongerAgent => "mode-no-longer-agent",
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Self::MeaningfulActivityResumed => "meaningful activity resumed; stuck flag cleared",
            Self::RepaintOutputStopped => {
                "repaint output went stale; stuck flag cleared (no longer a repaint loop)"
            }
            Self::TerminalNotRunning => "terminal no longer running; stuck flag cleared",
            Self::ModeNoLongerAgent => "mode changed away from agent mode; stuck flag cleared",
        }
    }
}

/// Outcome of the attach-time geometry application (TERM-07;
/// `broker.ts:358-397` `shouldResize` + `resizeIfSessionMatches` parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachResizeStatus {
    /// Geometry changed: cols/rows updated, epoch bumped, PTY resized.
    Resized,
    /// Geometry already matched: no epoch bump, no PTY syscall (Node `unchanged`).
    Unchanged,
    /// The intent/subscriber condition said not to resize (Node `shouldResize` false).
    Skipped,
    /// Terminal is not running (Node `not_running`): no mutation.
    NotRunning,
    /// Unknown terminal id (Node `missing`).
    Missing,
}

/// Apply an attach-supplied geometry while the caller holds the terminal-state
/// lock. `attach_with_geometry` invokes this immediately before it snapshots
/// replay and installs the subscriber, which makes the first-viewer claim
/// indivisible from the subscriber topology that authorizes it.
fn apply_attach_geometry(
    s: &mut TerminalShared,
    intent: TerminalAttachIntent,
    cols: u16,
    rows: u16,
    pty: Option<&PtyTerminal>,
) -> AttachResizeStatus {
    let cols = cols.max(TerminalRegistry::MIN_GEOMETRY_DIM);
    let rows = rows.max(TerminalRegistry::MIN_GEOMETRY_DIM);
    let should_resize = match intent {
        TerminalAttachIntent::ViewportHydrate | TerminalAttachIntent::TransportReconnect => {
            s.subscribers.is_empty()
        }
        TerminalAttachIntent::KeepaliveDelta => false,
    };
    if !should_resize {
        return AttachResizeStatus::Skipped;
    }
    if s.status != TerminalRunStatus::Running {
        return AttachResizeStatus::NotRunning;
    }

    // Node records geometry for both `resized` and `unchanged` results when
    // the attach is allowed. The first client record never bumps the epoch.
    let first_record = !s.has_client_geometry;
    s.has_client_geometry = true;
    if s.cols == cols && s.rows == rows {
        return AttachResizeStatus::Unchanged;
    }
    s.cols = cols;
    s.rows = rows;
    if !first_record {
        s.geometry_epoch += 1;
    }
    // The PTY master's mutex is independent from this terminal-state lock and
    // has no registry callback. Resizing here keeps OS geometry ahead of the
    // attach.ready/replay handoff without opening a second first-viewer race.
    if let Some(pty) = pty {
        pty.resize(cols, rows);
    }
    AttachResizeStatus::Resized
}

/// Read-only lookup into a session-identity store (in production: the WS-side
/// `TerminalIdentityRegistry` in `freshell-ws`). Injected across the crate
/// boundary so the D7 live-session guard can join BOTH stores from crates that
/// cannot depend on `freshell-ws` (`freshell-freshagent` -- would be circular).
/// Implementations must NOT return retired/dead bindings.
pub trait SessionIdentityLookup: Send + Sync + std::fmt::Debug {
    /// The terminal_id currently bound to `(provider, session_id)`, if any.
    fn terminal_for_session(&self, provider: &str, session_id: &str) -> Option<String>;
}

/// Write-side pane-identity seam — [`SessionIdentityLookup`]'s twin for the
/// REST spawn pipeline (kata hbsa). Consumed by `freshell-freshagent`'s REST
/// create/split/respawn call sites (which cannot depend on `freshell-ws` —
/// circular); produced by `freshell-ws`'s `LedgerPaneIdentityBinder`
/// (identity registry + pane ledger), wired in `freshell-server::main`.
///
/// Fully synchronous ON PURPOSE: every underlying operation is sync (the
/// identity registry is a plain `RwLock`, every ledger writer a plain
/// `fn -> io::Result<()>`), and the one caller that CANNOT be async is the
/// pane exit hook — [`crate::pty::ExitHook`] is a `FnOnce` invoked on the
/// plain OS reader thread where no tokio runtime exists. Async REST call
/// sites hop ledger-touching calls through `tokio::task::spawn_blocking`.
pub trait PaneIdentityBinder: Send + Sync + std::fmt::Debug {
    /// PIN 2 durability-before-argv: durable claude binding row written
    /// BEFORE the spawn makes the preallocated id observable. Callers gate
    /// this on their fresh-prealloc flag ONLY (eaa25b7d).
    fn record_prespawn_claude_binding(
        &self,
        session_id: &str,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    );
    /// Compensating delete when the spawn that minted the id fails.
    /// MUST be gated on the SAME predicate as the record (eaa25b7d).
    fn delete_prespawn_claude_binding(&self, session_id: &str);
    /// Post-spawn identity registration, mirroring the WS post-spawn block
    /// (freshell-ws/src/terminal.rs): identity row + durable binding for any
    /// non-shell create with a session id; pending marker for the
    /// locator-resolved providers (codex/opencode/amplifier) without one.
    /// `observed` (b8ke ext r27 F2): the ownership (epoch, generation) pair
    /// the spawning lifecycle operation holds — a handoff runner's terminal
    /// target passes its SUPPLIED handoff pair so the durable row carries
    /// the handoff's generation (the delayed-write fence baseline); other
    /// callers pass `None` (legacy-unfenced; the row's prior stamp is
    /// preserved by the write path).
    /// b8ke ext r27 F3: the registration is TYPED — the durable write's
    /// failure propagates as `Err` so a handoff runner's terminal target can
    /// fail the handoff typed (never a committed Live owner with no
    /// recoverable registration). `Ok(())` covers every no-op arm (shell,
    /// marker-less modes) and every successful write; callers without a
    /// typed channel deliberately keep their documented degradation policy.
    fn register_create_identity(
        &self,
        terminal_id: &str,
        mode: &str,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
        observed: Option<(u64, u64)>,
    ) -> Result<(), std::io::Error>;
    /// Exit-side hygiene (load-bearing ledger A2): mirrors the WS pane
    /// EXIT hook (terminal.rs:1334-1342) EXACTLY — retire the identity row
    /// (in-memory flag flip) and delete any pending marker. Deliberately
    /// does NOT touch the ledger binding: `retire_closed` is the
    /// explicit-user-close trigger only ("P1.8 trigger (e)", the WS
    /// `terminal.kill` command path, terminal.rs:3849-3868, and the
    /// freshAgent providers' `handle_kill` since the delta-round-5
    /// retire-on-kill repair), never the natural-exit path,
    /// and the Bound-after-natural-exit ledger row is load-bearing —
    /// `auto_resume::pre_respawn_guard` reads a still-Bound row as "pane
    /// still wants this session" (auto_resume.rs:445-450) and the recovery
    /// inventory keys on `RetiredReason::Closed` meaning deliberate close
    /// (recovery_inventory.rs:299-301). Both A2 hazards are closed by the
    /// identity-row retire alone: the session directory joins identity
    /// rows for liveness (session_directory.rs:716-766, and rename handling
    /// can no longer rebind a dead pane — the sessions route's surviving
    /// session→terminal mirror resolves LIVE identities via `find_by_session`
    /// and only broadcasts beyond the live label write, sessions.rs:167-229
    /// region; the terminal→session rename cascade is gone entirely, so
    /// nothing cascades terminal renames into identity/session writes),
    /// and the claude drain's no-op
    /// arm checks `current.retired` (claude_signal.rs:253-342), so a late
    /// new-id SessionStart cannot durably rebind a dead pane. Idempotent;
    /// harmless no-op for terminals with no identity row. Called from the
    /// pane exit hook for ALL non-shell creates. SYNC ON PURPOSE: the exit
    /// hook is a plain FnOnce on the PTY reader thread — blocking IO is
    /// safe there, .await is impossible (mirrors the WS exit hook,
    /// terminal.rs:1334-1342).
    fn retire_pane_identity(&self, terminal_id: &str);
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                terminals: HashMap::new(),
                revision: 0,
                respawn_generations: HashMap::new(),
            })),
            conn_seq: Arc::new(AtomicU64::new(1)),
            active_connections: Arc::new(AtomicI64::new(0)),
            auto_kill_idle_minutes: Arc::new(AtomicI64::new(DEFAULT_AUTO_KILL_IDLE_MINUTES)),
            stuck_window_ms: Arc::new(AtomicI64::new(DEFAULT_STUCK_WINDOW_MS)),
            scrollback_max_bytes: Arc::new(AtomicI64::new(DEFAULT_MAX_SCROLLBACK_CHARS)),
            paced_page_max_bytes: Arc::new(AtomicI64::new(DEFAULT_PACED_PAGE_MAX_BYTES)),
            activity_observer: Arc::new(std::sync::RwLock::new(None)),
            respawn_liveness_window_ms: Arc::new(AtomicI64::new(
                DEFAULT_RESPAWN_LIVENESS_WINDOW_MS,
            )),
            respawn_generation_cap: Arc::new(AtomicI64::new(DEFAULT_RESPAWN_GENERATION_CAP)),
            keyed_create_inflight: Arc::new(Mutex::new(std::collections::HashSet::new())),
            resume_create_inflight: Arc::new(Mutex::new(std::collections::HashSet::new())),
            session_ref_leases: Arc::new(Mutex::new(HashMap::new())),
            session_ref_bindings: Arc::new(Mutex::new(HashMap::new())),
            managed_controller: Arc::new(std::sync::RwLock::new(None)),
            managed_runtime_connections: Arc::new(Mutex::new(std::collections::HashSet::new())),
            ownership: None,
            session_ref_ownership: Arc::new(Mutex::new(HashMap::new())),
            terminal_create_pause: Arc::new(std::sync::RwLock::new(None)),
            terminal_attach_pause: Arc::new(std::sync::RwLock::new(None)),
            identity_readopt_pause: Arc::new(std::sync::RwLock::new(None)),
            terminal_create_postclaim_pause: Arc::new(std::sync::RwLock::new(None)),
            paced_exit_stage_hook: Arc::new(Mutex::new(None)),
        }
    }

    /// kata b8ke Task 4: wire the ONE server-wide runtime-ownership
    /// coordinator (release-only integration — see [`Self::ownership`]'s field
    /// doc). Builder form, matching the neighboring injection seams
    /// (`freshell-server::main` calls it right after `TerminalRegistry::new`).
    pub fn with_ownership(
        mut self,
        ownership: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    ) -> Self {
        self.ownership = Some(ownership);
        self
    }

    /// Mint a unique id for one WS connection (used to key its subscriptions so
    /// socket-close can sweep them out of every terminal).
    pub fn new_connection_id(&self) -> u64 {
        self.active_connections.fetch_add(1, Ordering::Relaxed);
        self.conn_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// DIAG-05: the live count of currently-open `/ws` connections (see
    /// `active_connections`'s field doc for exactly which call sites
    /// increment/decrement it). Surfaced as `GET /api/debug`'s
    /// `wsConnections`.
    pub fn connection_count(&self) -> usize {
        self.active_connections.load(Ordering::Relaxed).max(0) as usize
    }

    /// `registry.setSettings(settings)`'s `autoKillIdleMinutes` slice
    /// (`terminal-registry.ts:1316-1322`): update the idle-kill threshold the
    /// NEXT sweep reads. Callers (the boot-time settings load, and any future
    /// live `PATCH /api/settings` wiring) push `settings.safety.autoKillIdleMinutes`
    /// here; `<= 0` disables the sweep (legacy: `!killMinutes || killMinutes <= 0`).
    /// Install the TERM-15/TERM-16 activity tap (see [`ActivityEvent`]).
    /// Set once at boot by the activity hub; later calls replace it.
    pub fn set_activity_observer(&self, observer: ActivityObserver) {
        *self
            .activity_observer
            .write()
            .expect("activity observer lock") = Some(observer);
    }

    /// kata b8ke Task 7: install the terminal-create pause hook (the
    /// deterministic-race tests inject here — see
    /// [`TerminalCreatePauseHook`]). Interior-shared: every cloned registry
    /// handle (the WS state's, the REST spawn state's) observes it. Never
    /// set in production.
    pub fn set_terminal_create_pause_for_tests(&self, hook: TerminalCreatePauseHook) {
        *self
            .terminal_create_pause
            .write()
            .expect("terminal create pause lock") = Some(hook);
    }

    /// b8ke ext r12 F2: install the terminal-ATTACH pause hook — the
    /// deterministic-race tests park the attach handler INSIDE its
    /// coordinator window (after the guard arms, before the attach
    /// completes) to prove a concurrent handoff answers the typed Blocked
    /// outcome. Interior-shared like the create seam. Never set in
    /// production.
    pub fn set_terminal_attach_pause_for_tests(&self, hook: TerminalCreatePauseHook) {
        *self
            .terminal_attach_pause
            .write()
            .expect("terminal attach pause lock") = Some(hook);
    }

    /// b8ke ext r12 F2: clear the terminal-attach pause hook.
    pub fn clear_terminal_attach_pause_for_tests(&self) {
        *self
            .terminal_attach_pause
            .write()
            .expect("terminal attach pause lock") = None;
    }

    /// b8ke ext r39 F1: install the identity re-adopt PRE-ARM pause hook —
    /// the deterministic-race tests park `coordinator_begin_identity`'s
    /// re-adopt arm between the precheck observation and the atomic adopt.
    /// Never set in production.
    pub fn set_identity_readopt_pause_for_tests(&self, hook: IdentityReadoptPauseHook) {
        *self
            .identity_readopt_pause
            .write()
            .expect("identity re-adopt pause lock") = Some(hook);
    }

    /// b8ke ext r39 F1: clear the identity re-adopt pause hook.
    pub fn clear_identity_readopt_pause_for_tests(&self) {
        *self
            .identity_readopt_pause
            .write()
            .expect("identity re-adopt pause lock") = None;
    }

    /// b8ke ext r39 F1: read the identity re-adopt pause hook (None in
    /// production and every test that does not install it).
    pub fn identity_readopt_pause_hook(&self) -> Option<IdentityReadoptPauseHook> {
        self.identity_readopt_pause
            .read()
            .expect("identity re-adopt pause lock")
            .clone()
    }

    /// b8ke ext r13 F1: install the terminal-create POST-CLAIM pause hook —
    /// the deterministic-race tests park the create handler AFTER the
    /// coordinator claim (inside its held-authority window) to prove a
    /// concurrent handoff begin answers the typed Blocked outcome. Interior-
    /// shared like the create seam. Never set in production.
    pub fn set_terminal_create_postclaim_pause_for_tests(&self, hook: TerminalCreatePauseHook) {
        *self
            .terminal_create_postclaim_pause
            .write()
            .expect("terminal create postclaim pause lock") = Some(hook);
    }

    /// b8ke ext r13 F1: clear the post-claim create pause hook.
    pub fn clear_terminal_create_postclaim_pause_for_tests(&self) {
        *self
            .terminal_create_postclaim_pause
            .write()
            .expect("terminal create postclaim pause lock") = None;
    }

    /// b8ke ext r13 F1: the clone-out read of the post-claim create pause
    /// hook.
    pub fn terminal_create_postclaim_pause_hook(&self) -> Option<TerminalCreatePauseHook> {
        self.terminal_create_postclaim_pause
            .read()
            .expect("terminal create postclaim pause lock")
            .clone()
    }

    /// b8ke ext r12 F2: the clone-out read of the attach pause hook (the
    /// caller clones the Arc first, awaits after — never hold a lock
    /// across an await).
    pub fn terminal_attach_pause_hook(&self) -> Option<TerminalCreatePauseHook> {
        self.terminal_attach_pause
            .read()
            .expect("terminal attach pause lock")
            .clone()
    }

    /// kata b8ke Task 7: clear the terminal-create pause hook (the race
    /// tests' between-scenarios cleanup).
    pub fn clear_terminal_create_pause_for_tests(&self) {
        *self
            .terminal_create_pause
            .write()
            .expect("terminal create pause lock") = None;
    }

    /// kata b8ke Task 7: the clone-out read of the terminal-create pause
    /// hook for `handle_create` — the caller clones the `Arc` out FIRST and
    /// awaits the hook's future AFTER the lock is released (never hold a
    /// lock across an await). `None` in production.
    pub fn terminal_create_pause_hook(&self) -> Option<TerminalCreatePauseHook> {
        self.terminal_create_pause
            .read()
            .expect("terminal create pause lock")
            .clone()
    }

    /// Fire the activity tap, if installed. Cheap no-op otherwise.
    fn notify_activity(&self, event: ActivityEvent) {
        let guard = self
            .activity_observer
            .read()
            .expect("activity observer lock");
        if let Some(observer) = guard.as_ref() {
            observer(event);
        }
    }

    pub fn set_auto_kill_idle_minutes(&self, minutes: i64) {
        self.auto_kill_idle_minutes
            .store(minutes, Ordering::Relaxed);
    }

    /// The currently-configured idle-kill threshold, minutes.
    pub fn auto_kill_idle_minutes(&self) -> i64 {
        self.auto_kill_idle_minutes.load(Ordering::Relaxed)
    }

    /// Wedge-backstop: set the stuck-detection meaningful-idle window (ms).
    /// `<= 0` disables the sweep (mirrors `set_auto_kill_idle_minutes`'
    /// disable semantics); visible on the NEXT `enforce_stuck_detection`
    /// sweep, no restart required.
    pub fn set_stuck_window_ms(&self, ms: i64) {
        self.stuck_window_ms.store(ms, Ordering::Relaxed);
    }

    /// The currently-configured stuck-detection window, ms.
    pub fn stuck_window_ms(&self) -> i64 {
        self.stuck_window_ms.load(Ordering::Relaxed)
    }

    /// `registry.setSettings(settings)`'s `scrollbackMaxChars` recompute
    /// (`terminal-registry.ts:1317-1321`): update the replay-log byte cap NEW
    /// terminals will be created with (TERM-13). Callers pass
    /// `compute_scrollback_max_bytes(settings.terminal.scrollback)`, keeping this
    /// crate settings-type-agnostic (mirrors `set_auto_kill_idle_minutes`).
    ///
    /// NOTE (documented scope limit): legacy's `setSettings` ALSO resizes every
    /// ALREADY-CREATED terminal's buffer in place (`t.buffer.setMaxChars(...)`
    /// loop). This port only applies the cap to terminals created AFTER this
    /// call, matching the task's "respected at create" acceptance bar. Live
    /// `PATCH /api/settings` -> registry wiring DOES exist (commit f766ad6c:
    /// `apply_live_registry_settings`), so the setting applies without restart
    /// to newly-created terminals; in-place resize of already-open terminals
    /// remains deferred.
    pub fn set_scrollback_max_bytes(&self, max_bytes: i64) {
        self.scrollback_max_bytes
            .store(max_bytes, Ordering::Relaxed);
    }

    /// The byte cap NEW terminals are created with.
    pub fn scrollback_max_bytes(&self) -> i64 {
        self.scrollback_max_bytes.load(Ordering::Relaxed)
    }

    /// Responsive-terminal-restore Workstream 1: update the serialized-byte
    /// budget of one paced replay page. Applied to every page produced after
    /// the call (the per-page read takes the terminal lock briefly, so a
    /// live change is safe). Tests use small values for deterministic
    /// multi-page fixtures.
    pub fn set_paced_page_max_bytes(&self, max_bytes: i64) {
        self.paced_page_max_bytes
            .store(max_bytes, Ordering::Relaxed);
    }

    /// The current paced-page serialized-byte budget
    /// ([`DEFAULT_PACED_PAGE_MAX_BYTES`] unless configured).
    pub fn paced_page_max_bytes(&self) -> i64 {
        self.paced_page_max_bytes.load(Ordering::Relaxed)
    }

    /// E2R1 finding 1: the staged natural-exit code for one paced
    /// subscriber — `Some(code)` when the terminal exited naturally
    /// while THIS subscriber's paced deferral was still armed
    /// ([`Self::finish_pty_exit`] staged the exit instead of delivering
    /// it). The STAGING is the authority for the ws layer's
    /// exit-sequencing decisions: it happens under this terminal's lock
    /// BEFORE the connection's notify hook fires, so a query anywhere
    /// after that point observes it regardless of the notify's dispatch
    /// order. `None` when the terminal is gone, the subscriber is gone,
    /// or no exit is staged.
    pub fn staged_paced_exit(&self, terminal_id: &str, conn_id: u64) -> Option<i64> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|handle| Arc::clone(&handle.shared))?
        };
        let mut s = shared.lock().expect("terminal lock");
        let staged = s
            .subscribers
            .get(&conn_id)
            .and_then(|sub| sub.paced_exit_pending);
        // E2R3 test-support hook site: the one-shot staging fires AFTER
        // this read, INSIDE the same lock hold — the deterministic model
        // of the PTY reader staging its natural exit concurrently with
        // the caller's use of the state this read just returned (the
        // pre-fix arm's check-then-act window). Inert in production.
        self.fire_paced_exit_stage_hook(&mut s, terminal_id);
        staged
    }

    /// E2R3 test-support: arm the ONE-SHOT natural-exit staging hook.
    /// The next staged-exit read at a hook site performs the staging for
    /// `conn_id` with `exit_code` INSIDE that read's terminal-lock hold,
    /// immediately AFTER the read observes the pre-staging state —
    /// deterministically modeling a PTY reader staging a natural exit
    /// concurrently with the decision path's use of its read (the
    /// transition-race tests' interleave; never a sleep-based race). The
    /// hook fires once and clears itself; re-arming replaces a
    /// not-yet-fired payload.
    pub fn set_paced_exit_stage_hook_for_tests(&self, conn_id: u64, exit_code: i64) {
        *self
            .paced_exit_stage_hook
            .lock()
            .expect("paced exit stage hook") = Some(PacedExitStageHook { conn_id, exit_code });
    }

    /// E2R3 test-support: stage a natural exit for ONE paced subscriber
    /// from OUTSIDE any terminal lock — the deterministic staging the
    /// boundary test performs strictly AFTER an atomic transfer decision
    /// (an exit staged past the decision is the drain's documented
    /// uncredited tail content). Mirrors `finish_pty_exit`'s
    /// subscriber-relevant subset: the terminal flips to naturally
    /// `Exited` (monotone — a later real exit is inert) and the exit code
    /// stages on the DEFERRED subscriber only. `false` when the terminal
    /// or subscriber is gone, the subscriber is not deferred, or the
    /// terminal already exited.
    pub fn stage_natural_exit_for_test(
        &self,
        terminal_id: &str,
        conn_id: u64,
        exit_code: i64,
    ) -> bool {
        let Some(shared) = self.shared_for(terminal_id) else {
            return false;
        };
        let mut s = shared.lock().expect("terminal lock");
        stage_natural_exit_locked(&mut s, conn_id, exit_code)
    }

    /// E2R3 test-support: fire the armed one-shot staging hook at a hook
    /// site — INSIDE the caller's terminal-lock hold, immediately after
    /// the site's staged-exit read. Inert unless a test armed the hook;
    /// the staging is [`stage_natural_exit_locked`] (the real staging
    /// path's subscriber-relevant subset — callable here because the
    /// hook site already holds the lock).
    fn fire_paced_exit_stage_hook(&self, s: &mut TerminalShared, terminal_id: &str) {
        let Some(hook) = self
            .paced_exit_stage_hook
            .lock()
            .expect("paced exit stage hook")
            .take()
        else {
            return;
        };
        if stage_natural_exit_locked(s, hook.conn_id, hook.exit_code) {
            tracing::info!(
                terminal_id = %terminal_id,
                conn_id = hook.conn_id,
                exit_code = hook.exit_code,
                "terminal.paced_exit_staged_by_test_hook"
            );
        }
    }

    /// E2R3 (the atomic exit-transition decision): read one
    /// subscriber's staged-exit state and the terminal's head under a
    /// SINGLE terminal-lock hold and return the transition decision.
    /// This is the ONE authority the ws layer's drive sites sequence
    /// on — the credit path's pre-arm, the session start's arm, and
    /// (load-bearing) the post-drive disposition that commits
    /// extend-vs-transfer: because the staged-exit read and the
    /// decision value leave the lock TOGETHER, no concurrently
    /// staging PTY reader can invalidate the read before its caller
    /// commits the disposition. The pre-fix arm read the staging and
    /// the head in two separate holds and its disposition then decided
    /// from that stale read after a drive — the check-then-act window
    /// this closes structurally.
    ///
    /// A terminal/subscriber that is gone decides `exit_head: None`
    /// (nothing staged); the caller's drive or drain discovers the
    /// disappearance exactly as before.
    pub fn paced_exit_transition(&self, terminal_id: &str, conn_id: u64) -> PacedExitTransition {
        let Some(shared) = self.shared_for(terminal_id) else {
            return PacedExitTransition { exit_head: None };
        };
        let mut s = shared.lock().expect("terminal lock");
        let exit_head = s
            .subscribers
            .get(&conn_id)
            .and_then(|sub| sub.paced_exit_pending)
            .map(|_| s.head_seq);
        // E2R3 test-support hook site: the one-shot staging fires
        // AFTER this read, INSIDE the same lock hold — the
        // deterministic model of the PTY reader staging its natural
        // exit concurrently with THIS decision's use of its read. The
        // transition-race tests' interleave. Inert in production.
        self.fire_paced_exit_stage_hook(&mut s, terminal_id);
        PacedExitTransition { exit_head }
    }

    /// The EFFECTIVE page budget for one paced attach (round-2 finding
    /// F3): the negotiated `replayPageBytes` request honored as an
    /// optional UPPER BOUND clamped to the registry's own cap —
    /// `min(requested, cap)` when present and positive, the cap when
    /// absent (missing/invalid requests already arrived as `None` via the
    /// protocol layer's lossy deserializer; the `> 0` filter here also
    /// guards direct embedders). One session keeps ONE budget: the caller
    /// records this on [`PacedSessionDesc::page_budget`] so credits and
    /// the tail drain page at the SAME bound that sized the first page.
    pub fn effective_paced_page_budget(&self, paced: &PacedAttachOptions) -> i64 {
        match paced.replay_page_bytes.filter(|requested| *requested > 0) {
            Some(requested) => self.paced_page_max_bytes().min(requested),
            None => self.paced_page_max_bytes(),
        }
    }

    /// Reconciliation §7.5: shrink/grow the liveness window a generation must
    /// survive to reset the respawn counter (tests use small values).
    pub fn set_respawn_liveness_window_ms(&self, ms: i64) {
        self.respawn_liveness_window_ms.store(ms, Ordering::Relaxed);
    }

    /// Reconciliation §7.5: how many consecutive short-lived generations
    /// exhaust a key.
    pub fn set_respawn_generation_cap(&self, cap: i64) {
        self.respawn_generation_cap.store(cap, Ordering::Relaxed);
    }

    /// Reconciliation §7.5: whether this `createRequestId` has hit the
    /// respawn-generation cap — the verdict derivation returns
    /// `dead_session(reason='respawn_exhausted')` instead of another
    /// `respawn`, restoring §7's "at most one respawn" bound as a guarantee.
    pub fn respawn_exhausted(&self, create_request_id: &str) -> bool {
        let cap = self.respawn_generation_cap.load(Ordering::Relaxed).max(1) as u32;
        let inner = self.inner.lock().expect("registry lock");
        inner
            .respawn_generations
            .get(create_request_id)
            .is_some_and(|count| *count >= cap)
    }

    /// ITEM-3: agent-CLI terminals (long-running assistant sessions) get a
    /// 24-hour idle HARD CAP instead of the configured threshold. An agent
    /// mid-work can be PTY-silent far longer than any reasonable idle
    /// threshold (long LLM calls, long tool runs), and `terminal.killed
    /// by="idle"` forensics showed busy amplifier sessions being reaped.
    /// NOT a full exemption: `status == Running` is not a loss-proof
    /// live-child signal (the Running→Exited flip's only natural trigger is
    /// the PTY reader's EOF; a descendant holding the slave fd wedges it —
    /// ledger A14), and this sweep is the only cleanup for wedged rows.
    /// CLOSED list mirroring the shipped agent-CLI extensions (`category:
    /// "cli"`, picker group `"agents"` under `extensions/`): unknown /
    /// future modes stay reapable (legacy behavior) until added here.
    fn is_agent_mode(mode: &str) -> bool {
        matches!(
            mode,
            "claude" | "codex" | "opencode" | "amplifier" | "gemini" | "kimi"
        )
    }

    /// ITEM-3: idle hard cap for agent modes (see [`Self::is_agent_mode`])
    /// AND for detached-but-wanted terminals of any mode (connection lost
    /// without an explicit `terminal.detach` — see
    /// `TerminalShared::released_by_client`). Keeps the sweep as a cleanup
    /// backstop for wedged/leaked rows without silently SIGKILLing a
    /// background session the user intends to come back to.
    const IDLE_HARD_CAP_MS: i64 = 24 * 60 * 60 * 1000;

    /// `enforceIdleKills()` (`terminal-registry.ts:1406-1425`): auto-kill every
    /// DETACHED **running** terminal idle beyond the configured threshold.
    /// `auto_kill_idle_minutes() <= 0` is legacy's disabled state -- a no-op.
    /// Idleness is measured against `last_meaningful_activity_at` (DEV-0009):
    /// self-generated repaint noise does not keep a detached terminal alive.
    /// "Detached" mirrors `term.clients.size > 0` continue-guard: any attached
    /// subscriber exempts the terminal regardless of idle time.
    /// Agent-mode terminals (see [`Self::is_agent_mode`]) use a 24-hour
    /// hard cap instead of the configured threshold — PTY silence is not
    /// idleness for an agent mid-work, but the sweep stays their cleanup
    /// backstop for wedged exit detection (ITEM-3, ledger A14). The same
    /// hard cap protects detached-but-WANTED terminals of any mode — ones
    /// whose client socket dropped without an explicit `terminal.detach`
    /// (browser closed, laptop asleep): the configured threshold applies
    /// only to genuinely-orphaned rows (`released_by_client`), so a
    /// background shell the user intends to return to is never silently
    /// killed after mere idle minutes (§1.3). Returns the
    /// killed terminal ids (empty when nothing was eligible), for callers that
    /// want to log/observe the sweep and for deterministic test assertions.
    ///
    /// Callers drive the 30s cadence externally (`startIdleMonitor`,
    /// `tr:1335-1340`) -- this crate is deliberately tokio-free (see module
    /// docs), so the periodic timer lives in `freshell-ws`
    /// (`spawn_idle_monitor`), not here.
    pub fn enforce_idle_kills(&self) -> Vec<String> {
        let auto_kill_idle_minutes = self.auto_kill_idle_minutes();
        if auto_kill_idle_minutes <= 0 {
            return Vec::new();
        }
        let now = now_ms();
        let idle_threshold_ms = auto_kill_idle_minutes.saturating_mul(60_000);
        let mut candidates: Vec<String> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .iter()
                .filter_map(|(id, handle)| {
                    if handle.managed.is_some() {
                        return None; // managed runtime lifetime is supervisor-owned
                    }
                    let s = handle.shared.lock().expect("terminal lock");
                    if s.status != TerminalRunStatus::Running {
                        return None; // only running
                    }
                    if !s.subscribers.is_empty() {
                        return None; // only detached
                    }
                    // DEV-0009: idleness is measured against the MEANINGFUL
                    // activity clock, not the every-frame last_activity_at —
                    // otherwise a detached animated TUI (spinner / ticking
                    // counter) is exempt from this sweep forever.
                    let idle_ms = now.saturating_sub(s.last_meaningful_activity_at);
                    // Two classes get the 24h hard cap instead of the
                    // configured threshold:
                    //  * ITEM-3: agent sessions (PTY silence is not idleness
                    //    for an agent mid-work);
                    //  * detached-but-WANTED terminals: the client never
                    //    explicitly released this terminal (its socket merely
                    //    dropped — browser closed, laptop asleep). The tmux
                    //    promise (§1.3 "background session") forbids silently
                    //    SIGKILLing it after mere idle minutes; the hard cap
                    //    keeps the sweep as the wedge/leak cleanup backstop.
                    // Only genuinely-orphaned rows (explicit `terminal.detach`
                    // of the last reference, or never referenced at all) are
                    // reaped at the configured threshold, as before.
                    if (Self::is_agent_mode(&s.mode) || !s.released_by_client)
                        && idle_ms < Self::IDLE_HARD_CAP_MS
                    {
                        return None;
                    }
                    if idle_ms < idle_threshold_ms {
                        return None; // not idle long enough yet
                    }
                    Some(id.clone())
                })
                .collect()
        };
        // Deterministic order for observability/tests; the reference iterates a
        // `Map` in insertion order, which this doesn't reproduce exactly, but no
        // caller (log line, test) depends on kill ORDER across multiple victims.
        candidates.sort();
        for id in &candidates {
            self.kill_internal(id, "idle", false);
        }
        // DIAG-01: a single summary event per sweep -- only when it actually
        // killed something (a no-op sweep, the common case on a 30s cadence,
        // would otherwise spam the log every tick).
        if !candidates.is_empty() {
            tracing::info!(count = candidates.len(), "terminal.idle_reap");
        }
        candidates
    }

    /// Flag/unflag agent-mode RUNNING terminals whose output-only MEANINGFUL
    /// clock went stale past the stuck window WHILE the output-only RAW
    /// output clock keeps flowing — the wedge differential (a pure repaint
    /// loop: the eternal spinner keeps painting, but the NoiseScanner never
    /// sees genuinely-new content). The activity-freshness conjunct is what
    /// separates a WEDGED repaint loop (the eternal spinner keeps painting —
    /// raw output fresh) from a pane sitting quietly at a prompt or mid-idle
    /// (both output clocks equally stale — NOT the requested detection
    /// class, and flagging it would alter non-wedged panes). Emits
    /// transitions ONLY on state change (stuck:false→true and true→false);
    /// never kills, never emits a turn-complete, and unlike
    /// `enforce_idle_kills` does NOT exempt attached terminals — an attached
    /// wedged pane is the primary failure class this sweep exists for (see the
    /// 2026-09-18 opencode zombie RCA). A wedged pane whose output later FREEZES
    /// entirely stops matching (no longer a repaint loop) and the flag clears —
    /// an accepted safe-direction residual. Deliberately NO busy/turn-in-flight
    /// gate: the zombie class attaches to aborted sessions with no reliable turn
    /// state, so a busy gate would produce false negatives on exactly the target
    /// class.
    ///
    /// Delta-review round 4, Finding 1: the STALENESS conjunct reads
    /// `last_meaningful_output_at` — the OUTPUT-ONLY twin of the reaper's
    /// `last_meaningful_activity_at` — so the last-subscriber teardown grace
    /// bumps (detach / socket-close, which exist for the idle reaper's
    /// threshold) can never reset wedge detection: a page refresh of a wedged
    /// pane stays flagged.
    ///
    /// Episode-3 focused review r2, Finding 1: the FRESHNESS conjunct reads
    /// `last_output_activity_at` — the OUTPUT-ONLY twin of the wire-visible
    /// `last_activity_at` — from the same no-manufacture principle in the
    /// other direction: the mixed raw clock is refreshed by keystrokes too
    /// (`input`), so reading it let a single keypress mint the differential
    /// on a HEALTHY quiet pane (both output clocks stale past the window;
    /// the keypress refreshes the mixed clock → a false flag). Keystrokes
    /// and teardown grace touch NEITHER output clock — only real PTY
    /// output can prove a pane is still repainting.
    ///
    /// Episode-3 r3, Finding 3 (the tiny-window merely-exists case): the
    /// predicate additionally requires STRICT clock ordering —
    /// `last_output_activity_at > last_meaningful_output_at`. Both output
    /// clocks init to the creation time, so under a configured window
    /// smaller than [`STUCK_ACTIVITY_FRESH_MS`] a row that merely EXISTS
    /// past the window satisfies the staleness+freshness conjuncts without
    /// ever having emitted (its equal clocks are window-stale yet still
    /// freshness-fresh) and would flag a never-wedged pane. A wedge's
    /// repaint stream advances the raw clock STRICTLY past the frozen
    /// meaningful clock; a merely-quiet row's output clocks stay equal —
    /// the conjunct separates exactly those two classes and nothing else.
    ///
    /// Callers drive the cadence externally exactly like `enforce_idle_kills`
    /// (this crate is deliberately tokio-free, so the periodic timer lives in
    /// `freshell-ws`).
    pub fn enforce_stuck_detection(&self) -> Vec<StuckTransition> {
        let window = self.stuck_window_ms();
        if window <= 0 {
            return Vec::new();
        }
        let now = now_ms();
        // Two-pass collect-then-apply mirroring `enforce_idle_kills`' lock
        // discipline (registry-inner lock + per-row lock during the walk).
        // `stuck_since` is written under the same row lock IN-walk — nothing
        // is deferred to a second pass because no kill happens; the row lock
        // IS the atomicity boundary for the flag flip. Structured logging is
        // deferred until after the locks drop (the DIAG-01 discipline).
        let mut collected: Vec<(StuckTransition, i64, Option<StuckClearCause>)> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .filter_map(|handle| {
                    let mut s = handle.shared.lock().expect("terminal lock");
                    let should = s.status == TerminalRunStatus::Running
                        && Self::is_agent_mode(&s.mode)
                        && now.saturating_sub(s.last_meaningful_output_at) > window
                        && now.saturating_sub(s.last_output_activity_at) < STUCK_ACTIVITY_FRESH_MS
                        && s.last_output_activity_at > s.last_meaningful_output_at;
                    match (s.stuck_since.is_some(), should) {
                        (false, true) => {
                            s.stuck_since = Some(now);
                            Some((
                                StuckTransition {
                                    terminal_id: s.terminal_id.clone(),
                                    mode: s.mode.clone(),
                                    stuck: true,
                                    at: now,
                                },
                                now.saturating_sub(s.last_meaningful_output_at),
                                None,
                            ))
                        }
                        (true, false) => {
                            s.stuck_since = None;
                            // Delta-review round 3 (log accuracy): a clear
                            // has distinct causes — compute which one
                            // stopped the predicate from matching HERE, at
                            // predicate time under the row lock (the clocks
                            // and status may move on before the deferred
                            // log fires). Not-running takes priority:
                            // `finish_pty_exit` refreshes every activity
                            // clock while leaving the status, so checking
                            // the clocks first would mislabel a plain exit.
                            let cause = if s.status != TerminalRunStatus::Running {
                                StuckClearCause::TerminalNotRunning
                            } else if now.saturating_sub(s.last_meaningful_output_at) <= window {
                                StuckClearCause::MeaningfulActivityResumed
                            } else if now.saturating_sub(s.last_output_activity_at)
                                >= STUCK_ACTIVITY_FRESH_MS
                            {
                                StuckClearCause::RepaintOutputStopped
                            } else {
                                StuckClearCause::ModeNoLongerAgent
                            };
                            Some((
                                StuckTransition {
                                    terminal_id: s.terminal_id.clone(),
                                    mode: s.mode.clone(),
                                    stuck: false,
                                    at: now,
                                },
                                0,
                                Some(cause),
                            ))
                        }
                        _ => None,
                    }
                })
                .collect()
        };
        // Deterministic order for observability/tests (mirrors the idle
        // reaper's `candidates.sort()`).
        collected.sort_by(|a, b| a.0.terminal_id.cmp(&b.0.terminal_id));
        for (t, meaningful_idle_ms, cleared_cause) in &collected {
            if t.stuck {
                tracing::warn!(
                    component = "terminal-registry",
                    event = "terminal_stuck_flagged",
                    terminal_id = %t.terminal_id,
                    mode = %t.mode,
                    meaningful_idle_ms,
                    "agent pane flagged stuck; surfacing to pane"
                );
            } else {
                let cause = cleared_cause.expect("clear transitions carry their cause");
                tracing::info!(
                    component = "terminal-registry",
                    event = "terminal_stuck_cleared",
                    terminal_id = %t.terminal_id,
                    mode = %t.mode,
                    reason = cause.reason(),
                    "{}",
                    cause.message()
                );
            }
        }
        collected.into_iter().map(|(t, _, _)| t).collect()
    }

    /// `registry.create()` (`terminal-registry.ts:1544-1740`): spawn the PTY and
    /// register it as a **running** terminal owned by no connection. The PTY's reader
    /// thread frames output straight into this terminal's replay log (and fans out to
    /// any attached subscriber) via [`ingest`]. Bumps the inventory revision.
    ///
    /// Create does NOT attach — the client sends `terminal.attach` next (`§1.2`).
    ///
    /// `mode` and `resume_session_id` are the REAL launch identity, stamped
    /// onto the record (and the `terminal.created` tracing event) from birth.
    /// Both used to be hardcoded (`mode: "shell"`, `resume: None`) until the
    /// WS handler's later `set_meta` overwrote them — during the 2026-07-22
    /// codex-resume incident that lying log reported six codex panes as plain
    /// shells and actively misled the forensic investigation.
    ///
    /// 8 arguments (`clippy::too_many_arguments`): every one is a distinct,
    /// non-optional create input; a params struct would just restate the
    /// `terminal.create` wire message this crate deliberately doesn't own
    /// (same justification as [`Self::attach`]).
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        spec: &SpawnSpec,
        env: &std::collections::BTreeMap<String, String>,
        terminal_id: String,
        stream_id: String,
        mode: &str,
        resume_session_id: Option<&str>,
        create_request_id: Option<&str>,
        ring_max_bytes: Option<i64>,
        on_exit: Option<crate::pty::ExitHook>,
    ) -> io::Result<()> {
        // Duplicate-live-resume enforcement (amplifier identity plan,
        // validated fix F5/V7): the callers' `has_live_resume` pre-check is
        // check-then-act and can race across WS/REST tasks — this registry's
        // own §5.4 doc (keyed_create_inflight) names the exact TOCTOU. Claim
        // a resume-scoped reservation BEFORE the spawn and re-check live
        // rows under it; the row itself is inserted before the reservation
        // is released, so no observable gap remains. Scoped to amplifier:
        // other modes keep their existing create semantics.
        let resume_guard_key = if mode == "amplifier" {
            resume_session_id.map(|sid| format!("resume:{mode}:{sid}"))
        } else {
            None
        };
        if let Some(key) = &resume_guard_key {
            let claimed = self.begin_resume_create(key);
            let duplicate_live = self.identity_probe_rows().iter().any(|row| {
                row.mode == mode
                    && row.status == TerminalRunStatus::Running
                    && row.resume_session_id.as_deref() == resume_session_id
            });
            if !claimed || duplicate_live {
                if claimed {
                    self.end_resume_create(key);
                }
                // Distinguishable error contract consumed by the WS/REST
                // handlers: ErrorKind::AlreadyExists ⇒ "session already
                // open" reject.
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "duplicate live resume: {mode} session {} is already open in a live terminal",
                        resume_session_id.unwrap_or_default()
                    ),
                ));
            }
        }

        let now = now_ms();
        let shared = Arc::new(Mutex::new(TerminalShared {
            terminal_id: terminal_id.clone(),
            stream_id: stream_id.clone(),
            replay: VecDeque::new(),
            replay_chars: 0,
            // TERM-13: capture the CURRENTLY-configured scrollback cap at
            // creation time (`compute_scrollback_max_bytes`'s output -- a CHAR
            // budget despite the name, see that fn's doc comment -- seeded
            // from `settings.terminal.scrollback` at boot).
            max_replay_chars: self.scrollback_max_bytes().max(0) as usize,
            scanner: BarrierScanner::new(),
            modes: ModeTracker::new(),
            noise: NoiseScanner::new(),
            head_seq: 0,
            status: TerminalRunStatus::Running,
            exit_code: None,
            created_at: now,
            last_activity_at: now,
            last_output_activity_at: now,
            last_meaningful_activity_at: now,
            last_meaningful_output_at: now,
            stuck_since: None,
            cols: spec.cols,
            rows: spec.rows,
            geometry_epoch: 1,
            has_client_geometry: false,
            cwd: spec.cwd.clone(),
            title: "Shell".to_string(),
            description: None,
            mode: mode.to_string(),
            resume_session_id: resume_session_id.map(str::to_string),
            create_request_id: create_request_id.map(str::to_string),
            subscribers: HashMap::new(),
            claims: BTreeSet::new(),
            released_by_client: true,
            name_ref: None,
            naming_handle: None,
            session_name: None,
        }));

        // The reader thread invokes this for every framed terminal.output: append to
        // the replay log + fan out (stamped) to subscribers. Captures the shared
        // state, NOT the PTY (which does not exist yet).
        let sink_shared = Arc::clone(&shared);
        // TERM-15/TERM-16 output tap: CLI modes forward each framed output
        // chunk to the activity observer (BEL turn-complete detection +
        // liveness). Shell terminals skip the tap entirely (`tapped` false):
        // zero per-chunk overhead beyond one bool test.
        let tapped = mode != "shell";
        let tap_observer = Arc::clone(&self.activity_observer);
        let tap_terminal_id = terminal_id.clone();
        let sink: MessageSink = Box::new(move |msg| {
            if tapped {
                if let ServerMessage::TerminalOutput(frame) = &msg {
                    let guard = tap_observer.read().expect("activity observer lock");
                    if let Some(observer) = guard.as_ref() {
                        observer(ActivityEvent::Output {
                            terminal_id: tap_terminal_id.clone(),
                            data: frame.data.clone(),
                            at: now_ms(),
                        });
                    }
                }
            }
            ingest(&sink_shared, msg)
        });

        let pty = match PtyTerminal::spawn_with_sink(
            spec,
            env,
            terminal_id.clone(),
            stream_id,
            ring_max_bytes,
            Some(sink),
            on_exit,
        ) {
            Ok(pty) => pty,
            Err(err) => {
                // Spawn failed: release the resume reservation so a retry
                // isn't wedged behind a leaked claim (release-on-failure).
                if let Some(key) = &resume_guard_key {
                    self.end_resume_create(key);
                }
                return Err(err);
            }
        };

        // DIAG-01: terminal lifecycle event -- captured BEFORE `pty` is moved
        // into the registry, from the just-spawned PTY (so `pid` reflects
        // the real child, not a stale/absent value).
        let pid = pty.pid();

        let mut inner = self.inner.lock().expect("registry lock");
        inner.terminals.insert(
            terminal_id.clone(),
            TerminalHandle {
                shared,
                pty: Some(pty),
                managed: None,
                managed_read_in_flight: Arc::new(AtomicBool::new(false)),
            },
        );
        inner.revision += 1;
        drop(inner);

        // The row is now observable (inserted above) — release the resume
        // reservation. Insert-before-release means a concurrent create can
        // never observe "no reservation AND no row" (release-on-success).
        if let Some(key) = &resume_guard_key {
            self.end_resume_create(key);
        }

        // DIAG-01 + 2026-07-22 incident fix: log the REAL mode and whether a
        // resume id was applied. This line used to hardcode `mode = "shell"`,
        // which reported resumed codex panes as plain shells and misled the
        // incident investigation. (The wire `terminal.created` frame was
        // already correct -- it's built in the WS handler; only this LOG lied.)
        tracing::info!(
            terminal_id = %terminal_id,
            mode = %mode,
            resume_applied = resume_session_id.is_some(),
            cwd = %spec.cwd.as_deref().unwrap_or(""),
            pid = pid.unwrap_or(0),
            "terminal.created"
        );
        // §5.4 backstop: two live PTYs on one createRequestId is the
        // duplicate-writer data-loss shape — make it loud.
        if let Some(key) = create_request_id {
            self.warn_on_duplicate_live_ptys(key);
        }
        // TERM-15/TERM-16 tap: Created fires for every mode (the hub filters).
        self.notify_activity(ActivityEvent::Created {
            terminal_id,
            mode: mode.to_string(),
            resume_session_id: resume_session_id.map(str::to_string),
            at: now,
        });
        Ok(())
    }

    /// `broker.attach*()` (`broker.ts:258-610`): attach connection `conn_id` (with its
    /// `sink`) to `terminal_id`. Under the per-terminal lock: snapshot the replay set
    /// (`seqStart > sinceSeq`), register the subscriber, then enqueue `attach.ready`
    /// followed by the replayed frames (stamped + `source:'replay'`). Live frames the
    /// reader appends after we release the lock fan out to `sink` strictly after the
    /// replay — no gap, no duplicate (`§7.4`).
    ///
    /// Re-attaching the same `conn_id` REPLACES its subscription (new `attachRequestId`,
    /// re-replay) — the reconnect / viewport-hydrate path.
    ///
    /// `session_ref` is the terminal's canonical session identity, resolved by
    /// the CALLER (the WS handler owns the identity registry — this crate is
    /// deliberately identity-agnostic) and stamped verbatim onto the
    /// `terminal.attach.ready` frame (STATE-SYNC FIX 1 increment 2a: the frozen
    /// client folds `attach.ready.sessionRef` into pane identity via
    /// `reconcileTerminalSessionAssociation`, a repair channel that was dead
    /// while this frame hardcoded `None`).
    ///
    /// 10 arguments (`clippy::too_many_arguments`): every one is a distinct,
    /// non-optional attach input with exactly one call site outside tests
    /// (`freshell_ws::terminal::handle_attach`, which forwards the parsed
    /// `terminal.attach` frame fields 1:1) — a params struct would just
    /// restate the wire message this crate deliberately doesn't own.
    /// `surface_reset` is the client's positive "my xterm surface is fresh"
    /// marker (mode replay-sync); when `Some(true)` and an
    /// `attach_request_id` is present, the tracker-synthesized mode preamble
    /// is emitted once, strictly between `attach.ready` and the replay.
    /// `max_replay_bytes` is the attach's TERM-07 budget request — recorded
    /// on the subscriber with no delivery-behavior change (see
    /// [`Subscriber::max_replay_bytes`]). `paced` carries the negotiated
    /// round-2 paced-attach inputs ([`PacedAttachOptions`]): the
    /// `replayPageBytes` forward-page upper bound, honored as
    /// `min(requested, registry cap)` on the paced path and recorded on
    /// the session for every later page (round-2 finding F3).
    #[allow(clippy::too_many_arguments)]
    pub fn attach(
        &self,
        terminal_id: &str,
        conn_id: u64,
        sink: FrameSink,
        attach_request_id: Option<String>,
        since_seq: i64,
        terminal_output_batch_v1: bool,
        paced_terminal_replay_v1: bool,
        session_ref: Option<SessionLocator>,
        surface_reset: Option<bool>,
        max_replay_bytes: Option<i64>,
        paced: PacedAttachOptions,
    ) -> AttachOutcome {
        // Take the terminal's shared Arc under the registry lock, then drop the
        // registry lock so we hold ONLY the per-terminal lock during the handoff.
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get(terminal_id) {
                Some(h) => Arc::clone(&h.shared),
                None => {
                    return AttachOutcome {
                        found: false,
                        geometry: None,
                        paced: None,
                    }
                }
            }
        };

        self.attach_to_shared(
            terminal_id,
            conn_id,
            sink,
            attach_request_id,
            since_seq,
            terminal_output_batch_v1,
            paced_terminal_replay_v1,
            session_ref,
            surface_reset,
            max_replay_bytes,
            shared,
            None,
            paced,
        )
    }

    /// Atomically apply a geometry-bearing `terminal.attach` and install its
    /// subscriber. The geometry decision, PTY resize, subscriber insertion,
    /// ready, and replay share the same per-terminal lock, so two concurrent
    /// first viewers cannot both claim the PTY dimensions.
    ///
    /// The registry lock stays held only long enough to keep the PTY handle
    /// alive while the per-terminal handoff runs. Lock ordering remains
    /// registry → terminal everywhere that needs both locks.
    #[allow(clippy::too_many_arguments)]
    pub fn attach_with_geometry(
        &self,
        terminal_id: &str,
        conn_id: u64,
        sink: FrameSink,
        attach_request_id: Option<String>,
        since_seq: i64,
        terminal_output_batch_v1: bool,
        paced_terminal_replay_v1: bool,
        session_ref: Option<SessionLocator>,
        surface_reset: Option<bool>,
        max_replay_bytes: Option<i64>,
        intent: TerminalAttachIntent,
        cols: u16,
        rows: u16,
        paced: PacedAttachOptions,
    ) -> AttachOutcome {
        let inner = self.inner.lock().expect("registry lock");
        let Some(handle) = inner.terminals.get(terminal_id) else {
            return AttachOutcome {
                found: false,
                geometry: Some(AttachResizeStatus::Missing),
                paced: None,
            };
        };

        self.attach_to_shared(
            terminal_id,
            conn_id,
            sink,
            attach_request_id,
            since_seq,
            terminal_output_batch_v1,
            paced_terminal_replay_v1,
            session_ref,
            surface_reset,
            max_replay_bytes,
            Arc::clone(&handle.shared),
            Some((intent, cols, rows, handle.pty.as_ref())),
            paced,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn attach_to_shared(
        &self,
        terminal_id: &str,
        conn_id: u64,
        sink: FrameSink,
        attach_request_id: Option<String>,
        since_seq: i64,
        terminal_output_batch_v1: bool,
        paced_terminal_replay_v1: bool,
        session_ref: Option<SessionLocator>,
        surface_reset: Option<bool>,
        max_replay_bytes: Option<i64>,
        shared: Arc<Mutex<TerminalShared>>,
        geometry: Option<(TerminalAttachIntent, u16, u16, Option<&PtyTerminal>)>,
        paced: PacedAttachOptions,
    ) -> AttachOutcome {
        let mut s = shared.lock().expect("terminal lock");
        let geometry = geometry.map(|(intent, cols, rows, pty)| {
            apply_attach_geometry(&mut s, intent, cols, rows, pty)
        });

        // Responsive-terminal-restore Workstream 1: the paced path replaces
        // the inline full-replay burst ONLY for negotiated connections — and
        // only for a RUNNING terminal with an attachRequestId to correlate
        // continuation credits (the already-Exited path keeps the frozen
        // inline replay + synthetic exit, in their legacy order; a paced
        // attach without an attachRequestId cannot be credited and falls
        // back to the legacy inline replay, byte-identical to today).
        let paced_path = paced_terminal_replay_v1
            && attach_request_id.is_some()
            && s.status == TerminalRunStatus::Running;

        if paced_path {
            return self.paced_attach_to_shared(
                s,
                terminal_id,
                conn_id,
                sink,
                attach_request_id,
                since_seq,
                terminal_output_batch_v1,
                session_ref,
                surface_reset,
                max_replay_bytes,
                geometry,
                paced,
            );
        }

        let effective_since = since_seq.max(0);

        // Snapshot the replay window: every retained frame newer than the client's
        // cursor (`replaySince`, `replay-deque.ts:89-98`).
        let replay: Vec<RetainedFrame> = s
            .replay
            .iter()
            .filter(|f| f.output.seq_start > effective_since)
            .cloned()
            .collect();
        let head_seq = s.head_seq;
        // replayFromSeq/replayToSeq = first/last replayed span, else headSeq+1/headSeq
        // (`broker.ts:488-489`).
        let (replay_from, replay_to) = match (replay.first(), replay.last()) {
            (Some(a), Some(b)) => (a.output.seq_start, b.output.seq_end),
            _ => (head_seq + 1, head_seq),
        };

        // Restore contract (responsive-terminal-restore): on NEGOTIATED
        // attaches only, report the earliest sequence position still
        // available for replay — the RING's front (not the attach's replay
        // slice), or head+1 when nothing older than the head is retained.
        // Captured under the same lock as the replay snapshot so the bound is
        // consistent with it. Non-negotiated attaches leave it `None` (the
        // frozen client's ready frame stays byte-identical).
        let oldest_retained_seq = paced_terminal_replay_v1.then(|| s.oldest_retained_seq());

        // Register BEFORE enqueuing so any live frame the reader appends after we
        // release the lock is delivered strictly after this replay (the reader is
        // blocked on this same lock until we return).
        s.subscribers.insert(
            conn_id,
            Subscriber {
                sink: Arc::clone(&sink),
                attach_request_id: attach_request_id.clone(),
                terminal_output_batch_v1,
                paced_terminal_replay_v1,
                paced_deferred: false,
                paced_handoff_boundary: None,
                paced_exit_pending: None,
                paced_exit_notify: None,
                max_replay_bytes,
            },
        );
        // Somebody attached => this terminal is wanted. A later socket drop
        // (remove_connection) must NOT re-mark it fast-reap eligible — only an
        // explicit `terminal.detach` of the last reference does (see
        // `released_by_client`'s field docs).
        s.released_by_client = false;

        let ready = ServerMessage::TerminalAttachReady(TerminalAttachReady {
            head_seq,
            replay_from_seq: replay_from,
            replay_to_seq: replay_to,
            stream_id: s.stream_id.clone(),
            terminal_id: terminal_id.to_string(),
            attach_request_id: attach_request_id.clone(),
            effective_since_seq: Some(effective_since),
            geometry_authority: Some(s.geometry_authority()),
            geometry_epoch: Some(s.geometry_epoch),
            oldest_retained_seq,
            replay_reset_reason: None,
            requested_since_seq: Some(since_seq),
            session_ref,
        });
        sink(ready);

        // terminal.modes.sync (mode replay-sync): a surface-reset attach gets
        // ONE control-plane emulator-mode preamble, ordered ready < sync <
        // replay < live by construction — the per-terminal lock `s` is held
        // for the whole attach, so the output reader (blocked on this same
        // lock) cannot interleave a live frame. The sync travels the DIRECT
        // channel only (`output_frame_meta` returns None for it — pinned in
        // output_queue tests — so `freshell-ws`'s queue router hands it
        // straight back); it never enters the output queue/ring, so overflow
        // eviction and supersede/detach discards can never lose it. Gating:
        //  * flag Some(true) — this attach's surface is fresh;
        //  * attachRequestId present — the schema keeps it optional, but the
        //    client fails closed (`missing_attach_request_id`) on an untagged
        //    sync, so building one here would be pure waste;
        //  * non-empty synthesis — nothing to arm (fixture f15 shape), and
        //    with the client's completion-clear the skip is provably safe.
        // This single block ALSO serves the already-Exited attach path below
        // (sync < synthesized exit is legal on the wire; the frozen tail's
        // modes are exactly what a fresh surface needs to render it).
        if surface_reset == Some(true) {
            if let Some(arid) = attach_request_id.as_deref() {
                let data = s.modes.synthesize();
                if !data.is_empty() {
                    sink(ServerMessage::TerminalModesSync(TerminalModesSync {
                        terminal_id: terminal_id.to_string(),
                        attach_request_id: arid.to_string(),
                        stream_id: s.stream_id.clone(),
                        data,
                    }));
                }
            }
        }

        // Batch framing is used only with the capability AND an attachRequestId present
        // (`broker.ts:1315-1343`); otherwise legacy per-frame `terminal.output` (T1).
        match (terminal_output_batch_v1, attach_request_id.as_deref()) {
            (true, Some(arid)) => {
                deliver_batches(&sink, terminal_id, &replay, arid, "replay");
            }
            _ => {
                for frame in replay {
                    let mut out = frame.output;
                    out.attach_request_id = attach_request_id.clone();
                    out.source = Some(OutputSource::Replay);
                    sink(ServerMessage::TerminalOutput(out));
                }
            }
        }

        // Wedge-backstop Task 3 (LB-12): state the row's CURRENT stuck truth
        // to the NEW subscriber's sink only (never the broadcast bus), for
        // agent-mode Running rows, in BOTH directions — stuck:true while
        // flagged, stuck:false when healthy. A client that missed a
        // transition broadcast (offline during the flag or the clear)
        // reconciles its card on re-attach; repeated keepalive re-attach
        // re-sends the frame, which is harmless (the client fold is a
        // keyed set/clear — idempotent). Ordered after the replay and
        // before the already-Exited block by construction (the same
        // per-terminal lock is held for the whole handoff), preserving
        // ready < modes.sync < replay < live. Exited rows are excluded by
        // the gate: the synthetic exit below answers them, never a stuck
        // card.
        if Self::is_agent_mode(&s.mode) && s.status == TerminalRunStatus::Running {
            let stuck_truth = ServerMessage::TerminalStuck(TerminalStuck {
                terminal_id: terminal_id.to_string(),
                at: s.stuck_since.unwrap_or_else(now_ms),
                stuck: s.stuck_since.is_some(),
            });
            sink(stuck_truth);
        }

        // DEFECT 5b ("blank pane" on an instant-exit CLI failure): a terminal
        // that already exited before this attach (the create-then-instant-exit
        // race -- e.g. a resumed coding-CLI session whose process dies within
        // milliseconds) fanned its `terminal.exit` out to zero subscribers
        // (finish_pty_exit/kill run with nobody attached yet). Without this,
        // the newly-attached client gets replayed output (if any) and then
        // silence forever: no error, no exited state, no live output -- a
        // permanently blank/frozen pane. Synthesize the exit here so a client
        // attaching to an already-dead terminal is told, exactly once, just
        // like a client that was already attached when the process died.
        if s.status == TerminalRunStatus::Exited {
            let exit = ServerMessage::TerminalExit(TerminalExit {
                exit_code: s.exit_code.unwrap_or(0),
                terminal_id: terminal_id.to_string(),
            });
            sink(exit);
            s.subscribers.remove(&conn_id);
        }

        AttachOutcome {
            found: true,
            geometry,
            paced: None,
        }
    }

    /// The PACED attach handoff (responsive-terminal-restore Workstream 1):
    /// the negotiated Running-terminal replacement for the inline
    /// full-replay burst. Under the same per-terminal lock as the legacy
    /// path: apply geometry, resolve the retention-adjusted baseline, arm
    /// the subscriber's deferral (the ring becomes the staging), sink the
    /// ready/sync/retention-gap prelude, and SELECT the first page's frames
    /// (never a full-ring clone). The first page travels back to the ws
    /// caller — it is sunk only after the lock is released; the ws pacing
    /// coordinator owns the session (credits, tail drain, completion).
    ///
    /// Retention loss at attach (the requested baseline predates the
    /// retained ring): emit the negotiated `terminal.output.gap` with reason
    /// `replay_window_exceeded` for the exact lost interval
    /// `[effective+1, oldest-1]` plus the task-2 bounds fields, stamp the
    /// ready frame's `replayResetReason: retention_lost`, and CONTINUE from
    /// what is retained (baseline `oldest-1`) — nothing is killed, nothing
    /// stalls; the client shows the honest incomplete-history state.
    /// Non-negotiated attaches keep today's silent behavior exactly (see
    /// the legacy branch above).
    #[allow(clippy::too_many_arguments)]
    fn paced_attach_to_shared(
        &self,
        mut s: std::sync::MutexGuard<'_, TerminalShared>,
        terminal_id: &str,
        conn_id: u64,
        sink: FrameSink,
        attach_request_id: Option<String>,
        since_seq: i64,
        terminal_output_batch_v1: bool,
        session_ref: Option<SessionLocator>,
        surface_reset: Option<bool>,
        max_replay_bytes: Option<i64>,
        geometry: Option<AttachResizeStatus>,
        paced: PacedAttachOptions,
    ) -> AttachOutcome {
        let effective_requested = since_seq.max(0);
        let head_seq = s.head_seq;
        let oldest = s.oldest_retained_seq();

        // Retention loss: the first position the client needs
        // (`effective+1`) predates the retained ring.
        let retention_lost = effective_requested + 1 < oldest;
        let baseline = if retention_lost {
            oldest - 1
        } else {
            effective_requested
        };
        let arid = attach_request_id
            .clone()
            .expect("the paced path requires an attachRequestId");

        // Arm the deferral with the subscriber installation: from this
        // point until the session completes, ingest does NOT fan out to
        // this subscriber — the pages and the tail deliver its range in
        // seq order (the ring is the staging).
        s.subscribers.insert(
            conn_id,
            Subscriber {
                sink: Arc::clone(&sink),
                attach_request_id: Some(arid.clone()),
                terminal_output_batch_v1,
                paced_terminal_replay_v1: true,
                paced_deferred: true,
                paced_handoff_boundary: None,
                paced_exit_pending: None,
                paced_exit_notify: paced.paced_exit_notify.clone(),
                max_replay_bytes,
            },
        );
        s.released_by_client = false;

        // replayFrom/To describe the FULL window the session will deliver
        // (the same first/last-span meaning as legacy, projected onto the
        // paced range): `(baseline, head]`, or the empty span when the
        // baseline already sits at the head.
        let (replay_from, replay_to) = if baseline >= head_seq {
            (head_seq + 1, head_seq)
        } else {
            (baseline + 1, head_seq)
        };

        let ready = ServerMessage::TerminalAttachReady(TerminalAttachReady {
            head_seq,
            replay_from_seq: replay_from,
            replay_to_seq: replay_to,
            stream_id: s.stream_id.clone(),
            terminal_id: terminal_id.to_string(),
            attach_request_id: Some(arid.clone()),
            effective_since_seq: Some(baseline),
            geometry_authority: Some(s.geometry_authority()),
            geometry_epoch: Some(s.geometry_epoch),
            oldest_retained_seq: Some(oldest),
            replay_reset_reason: retention_lost.then_some(TerminalReplayResetReason::RetentionLost),
            requested_since_seq: Some(since_seq),
            session_ref,
        });
        sink(ready);

        // The modes.sync preamble, byte-identical to the legacy block (a
        // fresh surface still needs the emulator-mode prelude; the sync
        // stays ahead of the pages by admission order — the first page is
        // sunk only after this lock is released).
        if surface_reset == Some(true) {
            let data = s.modes.synthesize();
            if !data.is_empty() {
                sink(ServerMessage::TerminalModesSync(TerminalModesSync {
                    terminal_id: terminal_id.to_string(),
                    attach_request_id: arid.clone(),
                    stream_id: s.stream_id.clone(),
                    data,
                }));
            }
        }

        // The negotiated retention gap: ordered ahead of the pages by
        // admission (sunk here under the lock; the pages are sunk after it).
        if retention_lost {
            sink(ServerMessage::TerminalOutputGap(TerminalOutputGap {
                terminal_id: terminal_id.to_string(),
                stream_id: s.stream_id.clone(),
                attach_request_id: Some(arid.clone()),
                from_seq: effective_requested + 1,
                to_seq: oldest - 1,
                reason: TerminalOutputGapReason::ReplayWindowExceeded,
                head_seq: Some(head_seq),
                oldest_retained_seq: Some(oldest),
            }));
        }

        // Select the first page (bounded by the session's EFFECTIVE page
        // budget — round-2 finding F3: the negotiated `replayPageBytes`
        // request clamped to the registry's cap), cloning ONLY the
        // selected frames — never the whole ring. The SAME budget is
        // recorded on the session so credits and the tail drain page at
        // the requested bound too — the whole session honors the request,
        // not just the first page.
        let budget = self.effective_paced_page_budget(&paced);
        let first_page = if baseline < head_seq {
            paced_page_build(
                &s,
                conn_id,
                baseline,
                head_seq,
                budget,
                OutputSource::Replay,
            )
            .map(|build| build.messages)
            .unwrap_or_default()
        } else {
            Vec::new()
        };
        let page_end = first_page
            .last()
            .and_then(page_last_seq)
            .unwrap_or(baseline.max(head_seq));
        let page_bytes = first_page
            .iter()
            .map(|m| serde_json::to_string(m).map(|j| j.len()).unwrap_or(0))
            .sum::<usize>() as u64;

        AttachOutcome {
            found: true,
            geometry,
            paced: Some(PacedAttachStart {
                session: PacedSessionDesc {
                    terminal_id: terminal_id.to_string(),
                    stream_id: s.stream_id.clone(),
                    attach_request_id: arid,
                    target: head_seq,
                    effective_since: baseline,
                    page_end,
                    page_budget: budget,
                    page_bytes,
                },
                first_page,
            }),
        }
    }

    /// `broker.detach()` (`broker.ts:618-639`): drop `conn_id`'s subscription. The PTY
    /// keeps running and buffering — the background session (`§1.3`). No-op if the
    /// terminal or subscription is already gone.
    pub fn detach(&self, terminal_id: &str, conn_id: u64) {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        if let Some(shared) = shared {
            let mut s = shared.lock().expect("terminal lock");
            if s.subscribers.remove(&conn_id).is_some()
                && s.subscribers.is_empty()
                // A connection may still CLAIM this terminal's lifetime
                // (hidden pane, responsive-terminal-restore WS1): an explicit
                // detach releases only when the last reference of EVERY kind
                // is gone. Without claims this is always true, so the
                // pre-claim detach semantics are byte-identical.
                && s.claims.is_empty()
                && s.status == TerminalRunStatus::Running
            {
                // DEV-0009: a freshly-detached terminal gets a full idle
                // threshold of grace — its meaningful clock may have expired
                // while a watcher was attached (attached => reaper-exempt).
                // The wedge-backstop output clocks
                // (`last_output_activity_at`, `last_meaningful_output_at`)
                // are deliberately NOT bumped: the grace exists for the
                // idle reaper's threshold only, and a detach-reopen must
                // not reset stuck detection.
                s.last_meaningful_activity_at = s.last_meaningful_activity_at.max(now_ms());
                // The client explicitly released its LAST reference (the
                // detach reconciler only sends `terminal.detach` when a
                // terminal is gone from every pane layout): this terminal is
                // now genuinely orphaned and reap-eligible at the configured
                // threshold. Contrast `remove_connection`, which never sets
                // this — a dropped socket is not a released terminal.
                s.released_by_client = true;
            }
        }
    }

    /// Hidden-pane lifetime claim (responsive-terminal-restore Workstream 1):
    /// mark `terminal_id` wanted for `conn_id` WITHOUT attaching. Clears
    /// `released_by_client` under the terminal lock (if currently true) and
    /// records the claim per-connection. Never adds a subscriber, never
    /// grants replay or output delivery, never touches geometry or stream
    /// identity. Unknown ids are a no-op (`false`) — stale client layouts may
    /// claim rows that died server-side. Claims coexist with subscriptions:
    /// an attach to a claimed terminal behaves exactly as any attach, and
    /// the claim stays recorded until a later interest snapshot supersedes it
    /// or the socket sweeps it.
    pub fn claim_terminal(&self, terminal_id: &str, conn_id: u64) -> bool {
        let Some(shared) = self.shared_for(terminal_id) else {
            return false;
        };
        let mut s = shared.lock().expect("terminal lock");
        s.claims.insert(conn_id);
        // Wanted, exactly as a successful attach would mark it.
        s.released_by_client = false;
        true
    }

    /// Explicit withdrawal of a hidden-pane lifetime claim (a later interest
    /// snapshot no longer lists the id). Mirrors detach's last-reference
    /// release logic: when the LAST claim goes away and no subscribers
    /// remain, the terminal is genuinely orphaned — restore
    /// `released_by_client` with the same DEV-0009 fresh-idle-grace bump
    /// detach grants. A withdrawal that leaves other claimers (or any
    /// subscriber) keeps the terminal wanted.
    pub fn withdraw_claim(&self, terminal_id: &str, conn_id: u64) {
        let Some(shared) = self.shared_for(terminal_id) else {
            return;
        };
        let mut s = shared.lock().expect("terminal lock");
        if s.claims.remove(&conn_id)
            && s.claims.is_empty()
            && s.subscribers.is_empty()
            && s.status == TerminalRunStatus::Running
        {
            // DEV-0009: the release transition grants one full idle threshold
            // of grace (same rationale as detach).
            s.last_meaningful_activity_at = s.last_meaningful_activity_at.max(now_ms());
            s.released_by_client = true;
        }
    }

    /// Lifetime-claim observability (responsive-terminal-restore Workstream
    /// 1): how many distinct connections currently claim `terminal_id`, and
    /// whether the row is fast-reap eligible (`released_by_client`). `None`
    /// when the terminal does not exist. Test/diagnostic seam — no production
    /// decision path reads this.
    pub fn claim_state(&self, terminal_id: &str) -> Option<ClaimState> {
        let shared = self.shared_for(terminal_id)?;
        let s = shared.lock().expect("terminal lock");
        Some(ClaimState {
            claimers: s.claims.len(),
            released_by_client: s.released_by_client,
        })
    }

    /// Restore-contract sequence bounds for one terminal's retained replay
    /// ring (responsive-terminal-restore): current `head_seq` plus the
    /// earliest sequence position still available for replay. Takes the
    /// per-terminal lock briefly and copies NO payloads. `None` when the
    /// terminal does not exist.
    ///
    /// Callers must NOT hold the calling connection's writer admission lock:
    /// the terminal side (subscriber fan-out, attach replay) acquires that
    /// lock while holding THIS per-terminal lock, so resolving bounds under
    /// the admission lock would invert the established lock order.
    pub fn replay_bounds(&self, terminal_id: &str) -> Option<ReplayBounds> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        }?;
        let s = shared.lock().expect("terminal lock");
        Some(ReplayBounds {
            head_seq: s.head_seq,
            oldest_retained_seq: s.oldest_retained_seq(),
        })
    }

    /// Paced replay page read (responsive-terminal-restore Workstream 1):
    /// ONE bounded, ascending page of the `(from_seq, target]` window for a
    /// deferred subscriber's session, taking the per-terminal lock briefly
    /// (never across pages). The page is packed until the serialized budget
    /// (envelope + escaping + batch metadata, via the batch builder's
    /// accounting) is reached; a single frame whose own envelope exceeds the
    /// budget forms its own atomic single-frame page. Frames are selected
    /// BEFORE cloning — no full-ring snapshot per page.
    ///
    /// `Done` when `from_seq >= target`; `Expired` when retention evicted the
    /// next needed frames (exact lost interval `[from_seq+1, new_front-1]`,
    /// `resume_from = new_front-1`); `Gone` when the terminal or the
    /// subscriber disappeared (cancel the session).
    ///
    /// Callers must NOT hold the calling connection's writer admission lock
    /// (same lock-order rule as [`Self::replay_bounds`]).
    pub fn next_replay_page(
        &self,
        terminal_id: &str,
        conn_id: u64,
        from_seq: i64,
        target: i64,
        max_serialized_bytes: i64,
    ) -> PacedPage {
        let Some(shared) = self.shared_for(terminal_id) else {
            return PacedPage::Gone;
        };
        let s = shared.lock().expect("terminal lock");
        let Some(sub) = s.subscribers.get(&conn_id) else {
            return PacedPage::Gone;
        };
        if !sub.paced_terminal_replay_v1 {
            return PacedPage::Gone;
        }
        if from_seq >= target {
            return PacedPage::Done;
        }
        let oldest = s.oldest_retained_seq();
        if from_seq + 1 < oldest {
            return PacedPage::Expired {
                lost_from: from_seq + 1,
                lost_to: oldest - 1,
                resume_from: oldest - 1,
                head_seq: s.head_seq,
                oldest_retained_seq: oldest,
            };
        }
        match paced_page_build(
            &s,
            conn_id,
            from_seq,
            target,
            max_serialized_bytes,
            OutputSource::Replay,
        ) {
            Some(build) => PacedPage::Frames {
                messages: build.messages,
                end_seq: build.end_seq,
                serialized_bytes: build.serialized_bytes,
            },
            // Defensive: the window is non-empty and retained (checked
            // above), so an empty build means nothing the walk could select —
            // treat the window as delivered rather than stalling the session.
            None => PacedPage::Done,
        }
    }

    /// The paced drain's PAGED, FIXED-TARGET completion
    /// (responsive-terminal-restore W1): the caller (the connection's
    /// off-dispatch drain task) captures the drain target ONCE — the head
    /// when the drain phase starts — and this method pages the staged
    /// range `(from_seq, min(head, to_seq_inclusive)]` toward that FIXED
    /// target, ONE budget-bounded page per call, the lock held only per
    /// page (never across pages, so PTY ingestion interleaves and no
    /// full-suffix clone is ever built under a single hold). The caller
    /// loops until a completing verdict:
    ///
    /// - `CaughtUp` — the ring was drained past `from_seq`: the ATOMIC
    ///   deferral clear under this lock hold; live output resumes direct
    ///   fan-out.
    /// - `Completed` — this call's page covered the terminal's CURRENT
    ///   head (everything staged was delivered in this hold): the
    ///   ATOMIC deferral clear in the SAME lock hold. Live output
    ///   resumes direct fan-out.
    /// - `TargetCovered` — the page covered the FIXED target while the
    ///   producer staged frames BEYOND it. NO bulk re-fan, NO clear: the
    ///   deferral STAYS armed and the staged post-target remainder is
    ///   handed to [`Self::handoff_paced_tail`]. This verdict is
    ///   COMPLETION START (round-4): the head read under THIS hold is the
    ///   completion boundary B, captured ONCE and recorded on the
    ///   subscriber — the handoff pages up to B and ONLY B (never the
    ///   moving current head), so a producer appending at-or-above drain
    ///   speed can never postpone completion. NO RECAPTURE, ever: a
    ///   target covered is a target handed off.
    /// - `Handoff` — one budget-bounded page delivered; the deferral
    ///   STAYS armed (ordering with live frames is preserved by the
    ///   deferral itself: ingest stages without fanning out, so live
    ///   output can never overtake an un-sent page); advance the cursor
    ///   and call again.
    /// - `Expired` — retention advanced past `from_seq`: the exact
    ///   bounds-carrying interval for the omitted range; the caller emits
    ///   the retention gap and continues from the resumed front — never
    ///   a silent forward jump to the ring front.
    /// - `Gone` — the terminal, the subscriber, or the SESSION'S ATTACH
    ///   GENERATION is gone. The generation guard is load-bearing for
    ///   the OFF-DISPATCH drain: the drain task runs concurrently with
    ///   the connection dispatcher, so a re-attach mid-drain replaces
    ///   the subscriber's attach generation while the old drain is
    ///   still paging — an unguarded read would page with the NEW
    ///   generation's stamp and its "drained"/completing verdicts would
    ///   clear the NEW session's deferral, letting live output overtake
    ///   the new session's pages. The superseded drain cancels without
    ///   touching anything.
    ///
    /// Each page read's own budget bounds the per-iteration sink work;
    /// there is NO completing-call bulk re-fan (the round-3 finding) —
    /// every byte the completion admits goes through [`paced_page_build`]'s
    /// budget — and the caller's backpressure gate (the drain task awaits
    /// the connection queue's real capacity between pages) bounds the
    /// loop's admission against the connection queue.
    ///
    /// Callers must NOT hold the calling connection's writer admission
    /// lock (same lock-order rule as [`Self::replay_bounds`]).
    pub fn complete_paced_tail(
        &self,
        terminal_id: &str,
        conn_id: u64,
        expected_attach_request_id: &str,
        from_seq: i64,
        to_seq_inclusive: i64,
        max_serialized_bytes: i64,
    ) -> PacedTailCompletion {
        let Some(shared) = self.shared_for(terminal_id) else {
            return PacedTailCompletion::Gone;
        };
        let mut s = shared.lock().expect("terminal lock");
        let sub = match s.subscribers.get(&conn_id) {
            Some(sub) => sub,
            None => return PacedTailCompletion::Gone,
        };
        if !sub.paced_terminal_replay_v1 {
            return PacedTailCompletion::Gone;
        }
        // The superseded-generation guard (see the doc comment): only the
        // session that OWNS this subscriber's current attach generation
        // may page or clear.
        if sub.attach_request_id.as_deref() != Some(expected_attach_request_id) {
            return PacedTailCompletion::Gone;
        }
        let head_seq = s.head_seq;
        if from_seq >= head_seq {
            // THE ATOMIC CLEAR: nothing is staged beyond `from_seq`, and the
            // last page was sunk before this call — no un-sent page exists,
            // so direct fan-out from here on can never overtake a page.
            s.subscribers
                .get_mut(&conn_id)
                .expect("subscriber checked above")
                .paced_deferred = false;
            // Finding F1: a staged natural exit rides the completing hold —
            // ordered after everything already sunk, then the subscriber
            // retires.
            deliver_staged_paced_exit(&mut s, conn_id);
            return PacedTailCompletion::CaughtUp;
        }
        let oldest = s.oldest_retained_seq();
        if from_seq + 1 < oldest {
            // Retention advanced past the drain cursor mid-drain: report the
            // EXACT lost interval (never silently start at the ring front)
            // and let the caller resume from the new front.
            return PacedTailCompletion::Expired {
                lost_from: from_seq + 1,
                lost_to: oldest - 1,
                resume_from: oldest - 1,
                head_seq,
                oldest_retained_seq: oldest,
            };
        }
        let page_target = head_seq.min(to_seq_inclusive);
        let built = paced_page_build(
            &s,
            conn_id,
            from_seq,
            page_target,
            max_serialized_bytes,
            OutputSource::Live,
        );
        let Some(build) = built else {
            // Defensive: the window is non-empty and retained (checked
            // above), so an empty build means nothing the walk could
            // select — treat the window as delivered rather than stalling
            // the session. If anything remains staged beyond the fixed target,
            // the post-target handoff owns it (with the boundary captured
            // ONCE under this hold, exactly like the covering-page arm);
            // otherwise clear now.
            if to_seq_inclusive >= head_seq {
                s.subscribers
                    .get_mut(&conn_id)
                    .expect("subscriber checked above")
                    .paced_deferred = false;
                deliver_staged_paced_exit(&mut s, conn_id);
                return PacedTailCompletion::Completed {
                    end_seq: from_seq,
                    serialized_bytes: 0,
                };
            }
            s.subscribers
                .get_mut(&conn_id)
                .expect("subscriber checked above")
                .paced_handoff_boundary = Some(head_seq);
            return PacedTailCompletion::TargetCovered {
                end_seq: from_seq,
                serialized_bytes: 0,
            };
        };
        let sink = Arc::clone(&s.subscribers.get(&conn_id).expect("checked above").sink);
        for message in build.messages {
            sink(message);
        }
        if build.end_seq >= head_seq {
            // THE CLEARED-AT-PAGE COMPLETION: this page covered the head
            // read under THIS hold, so everything staged ≤ the head was
            // delivered in this hold. Clear the deferral in the same hold:
            // ingest is blocked on the lock, so nothing can be fanned out
            // between the page's sink and the clear; everything appended
            // later fans out at its own ingest, strictly after the page in
            // queue order. The boundary can neither lose nor duplicate a
            // frame.
            s.subscribers
                .get_mut(&conn_id)
                .expect("subscriber checked above")
                .paced_deferred = false;
            // Finding F1: the staged exit (if the terminal exited while
            // the deferral was armed) rides this completing hold — after
            // the final pages, exactly once.
            deliver_staged_paced_exit(&mut s, conn_id);
            return PacedTailCompletion::Completed {
                end_seq: build.end_seq,
                serialized_bytes: build.serialized_bytes,
            };
        }
        if build.end_seq >= to_seq_inclusive {
            // THE FIXED-TARGET HANDOFF — COMPLETION START (round-4): the
            // page covered the FIXED target while the producer staged
            // frames beyond it. NO bulk re-fan (round-3 finding: a
            // retained-suffix clone under this hold admits up to a ring
            // outside every page budget) and NO clear (the staged
            // remainder must be delivered before live output may overtake
            // it). The deferral STAYS armed — ingest keeps staging in seq
            // order — and the caller delivers the staged post-target
            // remainder through [`Self::handoff_paced_tail`]. THE
            // COMPLETION BOUNDARY B is the head captured ONCE under THIS
            // hold (the one sanctioned head read, at completion start —
            // recorded on the subscriber; the handoff re-reads NOTHING):
            // the handoff pages up to B and ONLY B, so a producer
            // appending at-or-above drain speed can never move the
            // completion boundary (the moving-head chase is structurally
            // gone).
            let sub = s
                .subscribers
                .get_mut(&conn_id)
                .expect("subscriber checked above");
            sub.paced_handoff_boundary = Some(head_seq);
            return PacedTailCompletion::TargetCovered {
                end_seq: build.end_seq,
                serialized_bytes: build.serialized_bytes,
            };
        }
        // More remains staged below the fixed target: the deferral stays
        // armed, the caller pages on.
        PacedTailCompletion::Handoff {
            end_seq: build.end_seq,
            serialized_bytes: build.serialized_bytes,
        }
    }

    /// The BOUNDED post-target handoff (responsive-terminal-restore W1,
    /// round-4 fix): after [`Self::complete_paced_tail`] covers the drain's
    /// FIXED target, the frames the producer staged BEYOND it are delivered
    /// here, ONE budget-bounded chunk per call, through the same normal
    /// live page projection the drain's own pages use ([`paced_page_build`],
    /// source `live`). THE COMPLETION BOUNDARY IS FIXED: B is the head
    /// captured ONCE at completion start (the `TargetCovered` hold,
    /// recorded on the subscriber as `paced_handoff_boundary`) and this
    /// method pages up to B and ONLY B — it contains NO read of the
    /// terminal's current head anywhere (the recurring moving-head-chase
    /// cause is structurally removed), so a producer appending at-or-above
    /// drain speed can never move the completion boundary or postpone
    /// completion past the B-derived page bound. The caller (the
    /// connection's off-dispatch drain task) loops under its real
    /// backpressure gate: the lock is held only per chunk, the connection
    /// queue's actual consumption bounds the loop's admission, and each
    /// hold admits at most one page budget — never a bulk retained-suffix
    /// clone.
    ///
    /// - `Handoff` — one chunk of `(from_seq, B]` delivered; the deferral
    ///   STAYS armed; advance the cursor and call again.
    /// - `Completed` — THE COMPLETING HOLD: this chunk covered B. The
    ///   frames the producer staged past B (its ingests already passed
    ///   while the deferral held them back) flow through the NORMAL LIVE
    ///   FAN-OUT PATH in this same hold (the completing sweep — the same
    ///   per-frame projection [`ingest`] uses, never a page build, never a
    ///   retained-suffix clone), and the deferral was CLEARED in the same
    ///   hold. The hold is the atomic boundary: everything staged up to it
    ///   was delivered in it, post-hold ingests fan out directly, and the
    ///   boundary can neither lose nor duplicate a frame. Ends the paced
    ///   session.
    /// - `GapCompleted` — the plan:146 bounded-baseline exit: retention
    ///   overran the handoff cursor mid-handoff. The EXACT bounds-carrying
    ///   gap for the evicted interval was sunk through the subscriber's
    ///   sink FIRST, then the retained window (the ring front through the
    ///   head) flowed through the same normal live path in this hold, and
    ///   the deferral cleared — the session COMPLETES AT THE RING FRONT
    ///   with the gap recorded; the paged handoff never resumes toward the
    ///   (unreachable) B. Ends the paced session.
    /// - `CaughtUp` — nothing is staged within the fixed boundary beyond
    ///   the cursor: the same atomic clear, nothing delivered this call.
    /// - `Gone` — the terminal, the subscriber, the deferral (another
    ///   path already cleared it), the completion boundary (no
    ///   `TargetCovered` hold ever armed one — a protocol violation), or
    ///   the session's attach generation is gone; cancel.
    ///
    /// Callers must NOT hold the calling connection's writer admission
    /// lock (same lock-order rule as [`Self::replay_bounds`]).
    pub fn handoff_paced_tail(
        &self,
        terminal_id: &str,
        conn_id: u64,
        expected_attach_request_id: &str,
        from_seq: i64,
        max_serialized_bytes: i64,
    ) -> PacedTailCompletion {
        let Some(shared) = self.shared_for(terminal_id) else {
            return PacedTailCompletion::Gone;
        };
        let mut s = shared.lock().expect("terminal lock");
        let sub = match s.subscribers.get(&conn_id) {
            Some(sub) => sub,
            None => return PacedTailCompletion::Gone,
        };
        if !sub.paced_terminal_replay_v1 {
            return PacedTailCompletion::Gone;
        }
        // The deferral must still be armed: a cleared deferral means live
        // fan-out already resumed (ingest delivers directly) — delivering
        // here would duplicate.
        if !sub.paced_deferred {
            return PacedTailCompletion::Gone;
        }
        if sub.attach_request_id.as_deref() != Some(expected_attach_request_id) {
            return PacedTailCompletion::Gone;
        }
        // THE FIXED COMPLETION BOUNDARY, captured ONCE at completion start
        // (the TargetCovered hold). This method NEVER reads the terminal's
        // current head: the boundary is subscriber state, so no per-call
        // re-capture path exists at all.
        let Some(boundary) = sub.paced_handoff_boundary else {
            // Protocol violation: the handoff phase only begins after the
            // TargetCovered verdict armed the boundary. Refuse rather than
            // guessing a target (the guessing is the convicted chase).
            return PacedTailCompletion::Gone;
        };
        if from_seq >= boundary {
            // Nothing is staged within the fixed boundary beyond the
            // cursor (defensive: the completing chunk covers B before the
            // cursor can reach it). The same completing-hold rule applies
            // past the boundary: a residual is declared, never swept.
            let back = s
                .replay
                .back()
                .map(|f| (f.output.seq_start, f.output.seq_end))
                .unwrap_or((boundary, boundary));
            if back.0 > boundary {
                return complete_at_fixed_boundary(&mut s, conn_id, boundary, back, from_seq, 0);
            }
            let sub = s
                .subscribers
                .get_mut(&conn_id)
                .expect("subscriber checked above");
            sub.paced_deferred = false;
            sub.paced_handoff_boundary = None;
            // Finding F1: the staged exit rides this completing hold too.
            deliver_staged_paced_exit(&mut s, conn_id);
            return PacedTailCompletion::CaughtUp;
        }
        let oldest = s.oldest_retained_seq();
        if from_seq + 1 < oldest {
            // THE plan:146 BOUNDED-BASELINE EXIT: retention overran the
            // handoff cursor mid-handoff. TWO exact bounds-carrying gaps are
            // sunk THROUGH THE SUBSCRIBER'S SINK in THIS hold — ordered
            // ahead of everything else: (1) the retention gap for the
            // EVICTED interval (from_seq+1, oldest-1] — unfetchable, the
            // honest retention-loss UX; (2) the delivery gap for the
            // RETAINED window the session will not deliver (oldest, back]
            // — fetchable, the client's checkpoint-cursor repair fetches it
            // as a fresh bounded paced session. Then the deferral clears
            // and the session COMPLETES AT THE RING FRONT with both gaps
            // recorded: the paged handoff does NOT resume toward B (a
            // finite retention window cannot guarantee convergence against
            // indefinitely faster output production), and nothing is swept
            // in this hold (plan:145: no pinned replay backlog, no
            // admission outside the page budget). (The gap frames'
            // headSeq bounds field is the retained ring's back seq_end —
            // an observability value read from the ring like `oldest`
            // itself, never a completion target.)
            let sink = Arc::clone(&s.subscribers.get(&conn_id).expect("checked above").sink);
            let arid = s
                .subscribers
                .get(&conn_id)
                .expect("checked above")
                .attach_request_id
                .clone();
            let back_seq = s
                .replay
                .back()
                .map(|f| f.output.seq_end)
                .unwrap_or(from_seq);
            sink(ServerMessage::TerminalOutputGap(TerminalOutputGap {
                terminal_id: terminal_id.to_string(),
                stream_id: s.stream_id.clone(),
                attach_request_id: arid.clone(),
                from_seq: from_seq + 1,
                to_seq: oldest - 1,
                reason: TerminalOutputGapReason::ReplayWindowExceeded,
                head_seq: Some(back_seq),
                oldest_retained_seq: Some(oldest),
            }));
            if back_seq >= oldest {
                sink(ServerMessage::TerminalOutputGap(TerminalOutputGap {
                    terminal_id: terminal_id.to_string(),
                    stream_id: s.stream_id.clone(),
                    attach_request_id: arid,
                    from_seq: oldest,
                    to_seq: back_seq,
                    reason: TerminalOutputGapReason::HandoffBoundaryReached,
                    head_seq: Some(back_seq),
                    oldest_retained_seq: Some(oldest),
                }));
            }
            let sub = s
                .subscribers
                .get_mut(&conn_id)
                .expect("subscriber checked above");
            sub.paced_deferred = false;
            sub.paced_handoff_boundary = None;
            // Finding F1: the retention-overrun bounded-baseline exit still
            // sequences a staged exit AFTER the exact gaps — the gap, then
            // exit, never exit-first.
            deliver_staged_paced_exit(&mut s, conn_id);
            return PacedTailCompletion::GapCompleted {
                lost_from: from_seq + 1,
                lost_to: oldest - 1,
                end_seq: from_seq,
                serialized_bytes: 0,
                // THE plan:146 bounded-baseline exit: a GENUINE retention
                // overrun (round-5 finding 3's diagnostics discriminator).
                reason: PacedGapExitReason::RetentionOverrun,
            };
        }
        // Everything past `boundary` that the producer staged while the
        // deferral held live admission back — the ring's retained tail past
        // the boundary, WITHOUT reading the terminal's current head: the
        // back frame's seq bounds, read from the ring exactly like
        // `oldest_retained_seq` reads the front.
        let back = s
            .replay
            .back()
            .map(|f| (f.output.seq_start, f.output.seq_end))
            .unwrap_or((boundary, boundary));
        let built = paced_page_build(
            &s,
            conn_id,
            from_seq,
            boundary,
            max_serialized_bytes,
            OutputSource::Live,
        );
        match built {
            Some(build) => {
                let sink = Arc::clone(&s.subscribers.get(&conn_id).expect("checked above").sink);
                for message in build.messages {
                    sink(message);
                }
                if build.end_seq >= boundary {
                    // THE COMPLETING HOLD: the chunk covered the FIXED
                    // boundary B — the session's own window is fully
                    // delivered, and the deferral clears ATOMICALLY in
                    // this same hold. The frames the producer staged past
                    // B are NOT swept here (plan:145: a one-hold
                    // ring-sized admission is a pinned replay backlog
                    // outside every bound): the session COMPLETES AT B,
                    // and when a residual exists its EXACT interval is
                    // declared as the bounds-carrying
                    // `handoff_boundary_reached` delivery gap — the
                    // client's bounded baseline recovery (the
                    // checkpoint-cursor repair, the queue_overflow
                    // contract) fetches it as a fresh bounded paced
                    // session. A quiet terminal (no residual) completes
                    // cleanly: post-hold ingests fan out directly at
                    // their own ingest, so the boundary can neither lose
                    // nor duplicate a frame.
                    return complete_at_fixed_boundary(
                        &mut s,
                        conn_id,
                        boundary,
                        back,
                        build.end_seq,
                        build.serialized_bytes,
                    );
                }
                PacedTailCompletion::Handoff {
                    end_seq: build.end_seq,
                    serialized_bytes: build.serialized_bytes,
                }
            }
            // Defensive: the window is non-empty and retained (checked
            // above), so an empty build means nothing the walk could
            // select — treat the window as delivered and take the same
            // completing-hold path rather than stalling the session.
            None => complete_at_fixed_boundary(&mut s, conn_id, boundary, back, from_seq, 0),
        }
    }

    /// Resolve a terminal's shared handle under the registry lock, then drop
    /// the registry lock (the page reads hold ONLY the per-terminal lock).
    fn shared_for(&self, terminal_id: &str) -> Option<Arc<Mutex<TerminalShared>>> {
        let inner = self.inner.lock().expect("registry lock");
        inner
            .terminals
            .get(terminal_id)
            .map(|h| Arc::clone(&h.shared))
    }

    /// On socket close: sweep `conn_id` out of EVERY terminal's subscriber set
    /// and lifetime-claim set. All PTYs keep running (background sessions),
    /// reattachable by a future socket. Transport loss is NOT release: the
    /// sweep never restores `released_by_client` — a terminal left with no
    /// subscribers and no claims by a socket drop stays wanted (24-hour hard
    /// cap only), exactly like an attached-then-disconnected one.
    pub fn remove_connection(&self, conn_id: u64) {
        self.active_connections.fetch_sub(1, Ordering::Relaxed);
        self.set_managed_runtime_connection(conn_id, false);
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        for shared in shareds {
            let mut s = shared.lock().expect("terminal lock");
            let removed_subscriber = s.subscribers.remove(&conn_id).is_some();
            let removed_claim = s.claims.remove(&conn_id);
            if (removed_subscriber || removed_claim)
                && s.subscribers.is_empty()
                && s.claims.is_empty()
                && s.status == TerminalRunStatus::Running
            {
                // DEV-0009: a freshly-detached terminal gets a full idle
                // threshold of grace — its meaningful clock may have expired
                // while a watcher was attached (attached => reaper-exempt).
                // The removal gate is essential here: this sweep visits
                // EVERY terminal, and an unconditional bump would reset the
                // countdown of unrelated, already-detached terminals on
                // every socket close. As in `detach`, the wedge-backstop
                // output clocks (`last_output_activity_at`,
                // `last_meaningful_output_at`) are deliberately NOT
                // bumped: a page refresh (socket drop + re-attach) must
                // not reset stuck detection.
                s.last_meaningful_activity_at = s.last_meaningful_activity_at.max(now_ms());
            }
        }
    }

    /// `terminal.input` write path (`terminal-registry.ts:3867-3894`): write bytes to
    /// the PTY; bump `lastActivityAt` and the DEV-0009 meaningful-activity reap clock.
    /// Unknown terminal => `InputOutcome { found: false }` (kata dtfn: previously a
    /// silent no-op; the caller now replies on the wire).
    pub fn input(&self, terminal_id: &str, data: &[u8]) -> InputOutcome {
        let (found, tapped_mode) = {
            let mut inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get_mut(terminal_id) {
                Some(handle) => {
                    if let Some(pty) = handle.pty.as_mut() {
                        let _ = pty.write_input(data);
                    } else {
                        // Headless rows have no PTY to receive bytes. Unreachable in
                        // production today (`register_headless` has no production
                        // callers — ledger A16), but never let input vanish without
                        // a trace (kata dtfn).
                        tracing::warn!(terminal_id, "input_to_headless_terminal_dropped");
                    }
                    let mut s = handle.shared.lock().expect("terminal lock");
                    let now = now_ms();
                    s.last_activity_at = now;
                    // User keystrokes are always meaningful for the IDLE
                    // REAPER's clock (DEV-0009 —
                    // `input_write_resets_the_idle_reap_clock` pins that
                    // half). The wedge-backstop output clocks
                    // (`last_output_activity_at` AND
                    // `last_meaningful_output_at`) are deliberately NOT
                    // bumped (episode-3 focused reviews, Finding 1 and
                    // r2 Finding 1): the wedge signal is PTY OUTPUT — raw
                    // and meaningful, the classifier's judgment of the
                    // pane's OUTPUT — so a user typing at / Ctrl+C-ing a
                    // genuinely wedged pane (the natural first response)
                    // must not clear or postpone the stuck state, and a
                    // keypress cannot mint wedge freshness on a quiet
                    // pane either
                    // (`keypress_does_not_manufacture_wedge_freshness`).
                    // A healthy engaged pane's keystroke echo arrives
                    // through `ingest`, which keeps both output clocks
                    // fresh through output anyway.
                    s.last_meaningful_activity_at = now;
                    (true, s.mode != "shell")
                }
                None => (false, false),
            }
        };
        // TERM-15/TERM-16 tap (outside the registry lock): CLI-mode input
        // feeds submit detection. Shell terminals skip it entirely.
        if tapped_mode {
            self.notify_activity(ActivityEvent::Input {
                terminal_id: terminal_id.to_string(),
                data: String::from_utf8_lossy(data).into_owned(),
                at: now_ms(),
            });
        }
        InputOutcome { found }
    }

    /// Node-parity geometry floor (`broker.ts:672-673`):
    /// `Math.max(2, Math.floor(Number.isFinite(cols) ? cols : 80))`. For
    /// `u16` input — always finite, always integral — the formula reduces
    /// exactly to `.max(2)`; the `floor` and non-finite-fallback arms are
    /// unrepresentable in the Rust type.
    pub(crate) const MIN_GEOMETRY_DIM: u16 = 2;

    /// `terminal.resize` (`terminal-registry.ts:3975-3995`): `unchanged` when cols/rows
    /// already match; else set them, `+1` the geometry epoch (`§5.3`) unless this is the
    /// first client geometry record (see `has_client_geometry`), and resize the PTY
    /// (errors swallowed, as node-pty's are).
    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) {
        let cols = cols.max(Self::MIN_GEOMETRY_DIM);
        let rows = rows.max(Self::MIN_GEOMETRY_DIM);
        let mut inner = self.inner.lock().expect("registry lock");
        if let Some(handle) = inner.terminals.get_mut(terminal_id) {
            {
                let mut s = handle.shared.lock().expect("terminal lock");
                let first_record = !s.has_client_geometry;
                s.has_client_geometry = true;
                if s.cols == cols && s.rows == rows {
                    return;
                }
                s.cols = cols;
                s.rows = rows;
                if !first_record {
                    s.geometry_epoch += 1;
                }
            }
            if let Some(pty) = handle.pty.as_ref() {
                pty.resize(cols, rows);
            }
        }
    }

    /// Test-only direct seam for the shared attach-geometry predicate. The
    /// production path is [`Self::attach_with_geometry`], which combines this
    /// decision with subscriber insertion under one terminal-state lock.
    #[cfg(test)]
    fn resize_for_attach(
        &self,
        terminal_id: &str,
        _conn_id: u64,
        intent: TerminalAttachIntent,
        cols: u16,
        rows: u16,
    ) -> AttachResizeStatus {
        let cols = cols.max(Self::MIN_GEOMETRY_DIM);
        let rows = rows.max(Self::MIN_GEOMETRY_DIM);
        let inner = self.inner.lock().expect("registry lock");
        let Some(handle) = inner.terminals.get(terminal_id) else {
            return AttachResizeStatus::Missing;
        };
        let mut s = handle.shared.lock().expect("terminal lock");
        apply_attach_geometry(&mut s, intent, cols, rows, handle.pty.as_ref())
    }

    /// Current geometry bookkeeping as `(cols, rows, geometry_epoch)`; `None`
    /// for an unknown terminal id. Test/diagnostic seam for the TERM-07
    /// attach-time resize (the values `attach.ready` stamps come from here).
    pub fn geometry(&self, terminal_id: &str) -> Option<(u16, u16, i64)> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.map(|shared| {
            let s = shared.lock().expect("terminal lock");
            (s.cols, s.rows, s.geometry_epoch)
        })
    }

    /// Remove a managed facade only AFTER its supervisor stop transaction has
    /// returned `VerifiedEmpty`. This is the sole managed-row removal door;
    /// ordinary `kill()` refuses managed rows to prevent web-owned callbacks
    /// from pretending they terminated the external workload.
    pub fn remove_managed_after_stop(&self, terminal_id: &str) -> bool {
        if !self.is_managed(terminal_id) {
            return false;
        }
        self.kill_internal(terminal_id, "managed_stop", true)
    }

    /// `registry.kill()` (`terminal-registry.ts:3997-4033`): remove the terminal, send
    /// `terminal.exit{exitCode:0}` to every attached connection, and SIGKILL+reap the
    /// PTY. Bumps the inventory revision. Returns whether the terminal existed.
    ///
    /// DIAG-01: this is the "api"-initiated kill path (a client's explicit
    /// `terminal.kill`); see [`Self::kill_internal`] for the `by`-tagged
    /// event other callers (idle-reap, shutdown) use.
    pub fn kill(&self, terminal_id: &str) -> bool {
        self.kill_internal(terminal_id, "api", false)
    }

    /// Shared kill implementation. `by` distinguishes the caller for the
    /// `terminal.killed` DIAG-01 event (`"api"` | `"idle"` | `"shutdown"`)
    /// without adding a public parameter to [`Self::kill`] (preserving that
    /// method's existing signature for `freshell-ws` and any other caller).
    fn kill_internal(&self, terminal_id: &str, by: &'static str, allow_managed: bool) -> bool {
        let handle = {
            let mut inner = self.inner.lock().expect("registry lock");
            if !allow_managed
                && inner
                    .terminals
                    .get(terminal_id)
                    .is_some_and(|handle| handle.managed.is_some())
            {
                tracing::warn!(terminal_id = %terminal_id, by = by,
                    "managed_terminal_legacy_kill_refused: supervisor stop is required");
                return false;
            }
            match inner.terminals.remove(terminal_id) {
                Some(handle) => {
                    inner.revision += 1;
                    Some(handle)
                }
                None => None,
            }
        };
        let Some(mut handle) = handle else {
            return false;
        };
        // sessionRef lease fix (finding 1): the kill path REMOVES the row
        // entirely, so `claim_session_ref`'s "known dead" probe (which needs
        // a registered-but-not-Running row) can never fire for a killed
        // winner — an UNKNOWN id would be honored as `BoundElsewhere{dead-id}`
        // forever. Prune any sessionRef binding pointing at this terminal at
        // row-removal time instead. This is the ONLY row-removal site
        // (natural exit RETAINS the row via `finish_pty_exit`). The `inner`
        // lock is already released here, so no ordering hazard.
        self.session_ref_bindings
            .lock()
            .expect("session-ref bindings lock")
            .retain(|_, bound_id| bound_id != terminal_id);
        let was_running = {
            let mut s = handle.shared.lock().expect("terminal lock");
            let was_running = s.status == TerminalRunStatus::Running;
            s.status = TerminalRunStatus::Exited;
            s.exit_code = Some(0);
            let exit = ServerMessage::TerminalExit(TerminalExit {
                exit_code: 0,
                terminal_id: terminal_id.to_string(),
            });
            for sub in s.subscribers.values() {
                (sub.sink)(exit.clone());
            }
            s.subscribers.clear();
            was_running
        };
        // SAFE-11/TERM-22 (stale-pid group-kill hardening, second independent
        // layer): only ever call `pty.kill()` when the registry itself still
        // believed this terminal was Running. A terminal already marked
        // `Exited` (via `finish_pty_exit` -- RETAINED in the inventory, see
        // that function's doc comment) reaches this same `kill()` whenever a
        // later, unrelated sweep (`kill_all`'s shutdown sweep walks EVERY
        // tracked id, including retained-exited ones) names it. Its
        // `PtyTerminal`'s cached OS pid may since have been recycled by the
        // kernel to a completely unrelated process group; blindly calling
        // `pty.kill()` here would attempt to SIGKILL that unrelated group.
        // (The `PtyTerminal` itself is independently hardened too --
        // `mark_naturally_exited` marks it reaped + drops the cached pid at
        // natural-exit time -- but this check means the registry never even
        // ATTEMPTS the call for a non-Running terminal, regardless of the
        // `PtyTerminal`'s own state.)
        if was_running {
            if let Some(mut pty) = handle.pty.take() {
                pty.kill();
            }
        }
        tracing::info!(terminal_id = %terminal_id, by = by, "terminal.killed");
        // kata b8ke Task 4 (round-1 review: NEVER release before the kill +
        // confirmed reap): the fenced coordinator release runs at the END of
        // the kill — AFTER the `pty.kill()` block above, whose return point
        // IS the confirmed reap for this port (an immediate SIGKILL-and-
        // reap, see `PtyTerminal::kill`'s doc comment). A release any
        // earlier would mark the key Vacant while the old writer was still
        // alive. Fenced: a newer owner or an in-flight Handoff no-ops it;
        // during an explicit kill's Stopping window (the WS `terminal.kill`
        // sequence begin_stopped first) the `Live`-only release no-ops and
        // the stop's own `commit_stop` finishes the transition.
        self.release_session_ref_ownership(terminal_id, by);
        // TERM-15/TERM-16 tap: a kill clears activity too — no stale blue.
        self.notify_activity(ActivityEvent::Exit {
            terminal_id: terminal_id.to_string(),
            at: now_ms(),
            spontaneous: false,
        });
        true
    }

    /// SAFE-11/TERM-22: reap **every** currently-tracked terminal on server
    /// shutdown — legacy parity with `terminal-registry.ts:4843`
    /// `shutdownGracefully()` (SIGTERM every running PTY, wait up to a
    /// timeout, force-kill the remainder) applied to the whole registry
    /// instead of one id at a time. This port's per-terminal [`Self::kill`]
    /// is already an immediate SIGKILL-and-reap (see `PtyTerminal::kill`'s
    /// doc comment), so `kill_all` reuses that same convention for every
    /// tracked terminal rather than introducing a second, SIGTERM-then-wait
    /// code path that no other caller in this port uses.
    ///
    /// Snapshots the id set first (rather than holding the registry lock
    /// while killing) so a `kill()` reentered from a terminal's own exit
    /// fan-out can't deadlock against this call. Returns the number of
    /// terminals actually killed, for shutdown logging/tests.
    pub fn kill_all(&self) -> usize {
        let ids: Vec<String> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .iter()
                .filter(|(_, handle)| handle.managed.is_none())
                .map(|(id, _)| id.clone())
                .collect()
        };
        ids.iter()
            .filter(|id| self.kill_internal(id, "shutdown", false))
            .count()
    }

    /// Read-only liveness probe: is a terminal with this id currently in the
    /// registry? Used by `freshell-ws`'s `terminal.create` requestId-dedupe
    /// guard for lazy eviction of settled entries whose terminal is gone
    /// (killed/exited). Registry-lock + `contains_key` — no tokio, no
    /// side effects.
    pub fn exists(&self, terminal_id: &str) -> bool {
        self.inner
            .lock()
            .expect("registry lock")
            .terminals
            .contains_key(terminal_id)
    }

    /// `finishTerminalPtyExit` (`terminal-registry.ts:1479-1510`), non-codex core —
    /// the NATURAL-exit path (the kill path stays in [`kill`](Self::kill), which
    /// removes the record first so this lookup misses, mirroring the original's
    /// `record.status === 'exited'` early-return at `tr:1760`). Marks the record
    /// `exited` (RETAINED in the inventory — the original reaps only beyond
    /// `MAX_EXITED_TERMINALS`, `tr:1512-1528`), stamps `lastActivityAt`, fans
    /// `terminal.exit{exitCode}` out to every attached connection, and drops the
    /// subscriptions (`record.clients.clear()`). Live-pinned against the original
    /// 2026-07-13 (`~/freshell-scratch-007/exit-{orig,rust}.json`): typing `exit`
    /// yields `terminal.exit{exitCode:0}` + inventory `status:"exited"`,
    /// `hasClients:false`, record retained.
    ///
    /// Called from the PTY reader thread's exit hook (after the final output
    /// frame; the exit code comes from the waiter thread's `child.wait()`).
    /// Deliberately does NOT drop the `TerminalHandle.pty` here — that would join
    /// the very reader thread this runs on.
    pub fn finish_pty_exit(&self, terminal_id: &str, exit_code: i64) -> bool {
        let shared = {
            let mut inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get_mut(terminal_id) {
                Some(handle) => {
                    // SAFE-11/TERM-22 (stale-pid group-kill hardening): mark
                    // the underlying PtyTerminal reaped + drop its cached pid
                    // NOW, at the moment of natural exit, rather than leaving
                    // it live in the (retained) record for a later, unrelated
                    // `kill()`/`kill_all()` to potentially re-signal against a
                    // since-recycled pid. Safe to call from here: it neither
                    // blocks nor joins any thread (see its own doc comment),
                    // which matters because natural exit runs THIS callback
                    // from inside the PtyTerminal's own reader thread.
                    if let Some(pty) = handle.pty.as_mut() {
                        pty.mark_naturally_exited();
                    }
                    Arc::clone(&handle.shared)
                }
                None => return false, // killed (kill removes the record) or unknown
            }
        };
        let mut s = shared.lock().expect("terminal lock");
        if s.status == TerminalRunStatus::Exited {
            return false;
        }
        let now = now_ms();
        s.status = TerminalRunStatus::Exited;
        s.exit_code = Some(exit_code);
        s.last_activity_at = now;
        // Post-exit rows are not stuck-flaggable anyway (the predicate
        // requires Running) — refresh every derived activity clock for
        // consistency.
        s.last_output_activity_at = now;
        s.last_meaningful_activity_at = now;
        s.last_meaningful_output_at = now;
        let respawn_key = s.create_request_id.clone();
        let lifetime_ms = now.saturating_sub(s.created_at);
        let exit = ServerMessage::TerminalExit(TerminalExit {
            exit_code,
            terminal_id: terminal_id.to_string(),
        });
        // Round-2 finding F1 — the exit fan-out is PARTITIONED. A
        // subscriber whose paced session is still DEFERRED (its final
        // output is staged in the ring, pages undelivered) must NOT
        // receive terminal.exit now: exit-first strands the deferred
        // range (the client's exit handler clears the attach and rejects
        // late frames). Stage the exit on the subscriber instead — the
        // session's drain drives the deferred range to completion and
        // the completing verdict delivers the staged exit in the SAME
        // lock hold, ordered after the final output through the same
        // sink (plan:190 sequenced exit delivery). The connection's
        // notify hook (collected here, fired OUTSIDE the lock below)
        // lets the ws layer move a still-CREDITED session into that
        // drain. Every OTHER subscriber keeps the frozen behavior:
        // exit now, subscription retired.
        let mut staged_notify: Vec<PacedExitNotify> = Vec::new();
        let mut retire_now: Vec<u64> = Vec::new();
        for (conn_id, sub) in s.subscribers.iter_mut() {
            if sub.paced_deferred {
                sub.paced_exit_pending = Some(exit_code);
                if let Some(notify) = sub.paced_exit_notify.clone() {
                    staged_notify.push(notify);
                }
            } else {
                (sub.sink)(exit.clone());
                retire_now.push(*conn_id);
            }
        }
        for conn_id in retire_now {
            s.subscribers.remove(&conn_id);
        }
        drop(s);
        // Fire the staged-exit notifications with NO lock held: the hook
        // only enqueues on the owning connection's channel and must never
        // re-enter this terminal's lock (it runs on the PTY reader
        // thread).
        for notify in staged_notify {
            notify(terminal_id, exit_code);
        }
        // Reconciliation §7.5: a generation that died inside the liveness
        // window counts toward the respawn cap; one that survived it resets
        // the counter (a healthy resume is not penalized). Natural exits only
        // — a user-initiated `kill` removes the record without passing here.
        if let Some(key) = respawn_key {
            let window = self.respawn_liveness_window_ms.load(Ordering::Relaxed);
            let mut inner = self.inner.lock().expect("registry lock");
            if lifetime_ms < window {
                *inner.respawn_generations.entry(key).or_insert(0) += 1;
            } else {
                inner.respawn_generations.remove(&key);
            }
        }
        tracing::info!(terminal_id = %terminal_id, exit_code = exit_code, "terminal.exited");
        // kata b8ke Task 4: the natural-exit confirmation — the reader
        // thread that runs this hook IS the confirmed reap — releases the
        // terminal's coordinator ownership fenced (a newer owner or an
        // in-flight handoff no-ops it; the auto-resume crash-recovery claim
        // that follows carries the retained fence this terminal committed
        // under).
        self.release_session_ref_ownership(terminal_id, "registry/natural-exit");
        // TERM-15/TERM-16 tap: natural exit clears activity (the hub removes
        // the record — no stale blue after exit, TERM-18 semantics).
        self.notify_activity(ActivityEvent::Exit {
            terminal_id: terminal_id.to_string(),
            at: now_ms(),
            spontaneous: true,
        });
        true
    }

    /// The live terminals for `terminal.inventory.terminals` (handshake + any refetch),
    /// sorted by `createdAt` then `terminalId` for a deterministic order.
    pub fn inventory(&self) -> Vec<InventoryTerminal> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        let mut out: Vec<InventoryTerminal> = shareds
            .iter()
            .map(|s| s.lock().expect("terminal lock").inventory())
            .collect();
        out.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.terminal_id.cmp(&b.terminal_id))
        });
        out
    }

    /// Lightweight identity-probe rows for the STATE-SYNC invariant sweep
    /// (`freshell_ws::invariants`): terminal id, mode, run status, creation
    /// time, and the registry-side resume id — WITHOUT the reassembled
    /// scrollback snapshot [`Self::directory`] pays for, so a periodic sweep
    /// can call this every tick.
    pub fn identity_probe_rows(&self) -> Vec<IdentityProbeRow> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        shareds
            .iter()
            .map(|shared| {
                let s = shared.lock().expect("terminal lock");
                IdentityProbeRow {
                    terminal_id: s.terminal_id.clone(),
                    mode: s.mode.clone(),
                    status: s.status,
                    created_at: s.created_at,
                    resume_session_id: s.resume_session_id.clone(),
                    cwd: s.cwd.clone(),
                }
            })
            .collect()
    }

    /// Set a terminal's directory metadata (title/description/mode/resumeSessionId) —
    /// the values `terminal-registry.ts:1544-1740` derives at create time
    /// (`getModeLabel(opts.mode)` title, the CLI resume session id, …). Split from
    /// [`create`](Self::create) so the shell-only create path keeps its signature;
    /// the WS `terminal.create` handler calls this with mode context. `None` leaves
    /// a field unchanged.
    pub fn set_meta(
        &self,
        terminal_id: &str,
        title: Option<String>,
        description: Option<String>,
        mode: Option<String>,
        resume_session_id: Option<String>,
    ) {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        if let Some(shared) = shared {
            let mut s = shared.lock().expect("terminal lock");
            if let Some(title) = title {
                s.title = title;
            }
            if let Some(description) = description {
                s.description = Some(description);
            }
            if let Some(mode) = mode {
                s.mode = mode;
            }
            if let Some(rsid) = resume_session_id {
                s.resume_session_id = Some(rsid);
            }
        }
    }

    /// `registry.updateTitle()` — the PATCH `/api/terminals/:id` write-through when a
    /// non-empty `titleOverride` lands (`terminals-router.ts:303`).
    pub fn update_title(&self, terminal_id: &str, title: &str) {
        self.set_meta(terminal_id, Some(title.to_string()), None, None, None);
    }

    /// Single-id read of a terminal's live title -- the SAME field the
    /// directory listing serves as `DirectoryEntry.title` (see
    /// [`directory`](Self::directory)), without cloning the whole directory.
    /// `None` for an unknown terminal id. Added for the auto-title sweep's
    /// out-of-sync comparison (`server/index.ts:885-905`'s per-terminal
    /// `term.title` read).
    pub fn title_of(&self, terminal_id: &str) -> Option<String> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.map(|s| s.lock().expect("terminal lock").title.clone())
    }

    /// Single-id read of a terminal's launch MODE — the same field the
    /// create path stamps onto the record (`"shell"`, a scoped CLI mode, or
    /// a fresh session type); `None` for an unknown terminal id. Added for
    /// the auto-title sweep's kilroy-only discrimination (unified agent
    /// names Task 4, review I3): a metadata-typed kilroy session whose live
    /// matches hold no scoped mode keeps the legacy ladder, while a live
    /// scoped-mode terminal means the durable session is also open through
    /// a supported mode (the singular-record rule).
    pub fn mode_of(&self, terminal_id: &str) -> Option<String> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.map(|s| s.lock().expect("terminal lock").mode.clone())
    }

    /// `registry.updateDescription()` — the PATCH write-through for
    /// `descriptionOverride` (`terminals-router.ts:304`).
    pub fn update_description(&self, terminal_id: &str, description: &str) {
        self.set_meta(terminal_id, None, Some(description.to_string()), None, None);
    }

    // ── Unified agent names (Task 2): naming metadata/accessors ────────────

    /// Unified agent names: write a terminal's naming binding (each
    /// `Option`-write argument keeps its current value when `None` — a
    /// binding advances, never erases). The registry row RETAINS
    /// `nameRef`/`namingHandle` so inventory/projection readers carry them
    /// without a round-trip; the existing session ownership logic is
    /// untouched.
    pub fn set_naming(
        &self,
        terminal_id: &str,
        name_ref: Option<freshell_protocol::session_names::SessionNameRef>,
        naming_handle: Option<String>,
    ) {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        if let Some(shared) = shared {
            let mut s = shared.lock().expect("terminal lock");
            if let Some(reference) = name_ref {
                s.name_ref = Some(reference);
            }
            if let Some(handle) = naming_handle {
                s.naming_handle = Some(handle);
            }
        }
    }

    /// Unified agent names: refresh the terminal's last-known canonical name
    /// projection (display cache only — never an accepted name input). The
    /// naming publisher calls this on every committed change; it also
    /// write-throughs the display title so the terminal presents the accepted
    /// name (the title string is a cache, per the rename-scope contract).
    pub fn update_session_name(
        &self,
        terminal_id: &str,
        record: &freshell_protocol::session_names::SessionNameRecord,
    ) {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        if let Some(shared) = shared {
            let mut s = shared.lock().expect("terminal lock");
            s.session_name = Some(record.clone());
            s.title = record.name.clone();
        }
    }

    /// Unified agent names: the terminal's last-known canonical name record
    /// (display cache), if any.
    pub fn session_name_of(
        &self,
        terminal_id: &str,
    ) -> Option<freshell_protocol::session_names::SessionNameRecord> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.and_then(|s| s.lock().expect("terminal lock").session_name.clone())
    }

    /// Unified agent names: the naming identity this terminal's name
    /// resolves through, if any.
    pub fn name_ref_of(
        &self,
        terminal_id: &str,
    ) -> Option<freshell_protocol::session_names::SessionNameRef> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.and_then(|s| s.lock().expect("terminal lock").name_ref.clone())
    }

    /// Unified agent names: every terminal row currently bound to `name_ref`
    /// (live OR exited — the display cache follows the binding, not the
    /// process). The naming publisher uses this to refresh caches after a
    /// committed change.
    pub fn terminals_bound_to(
        &self,
        name_ref: &freshell_protocol::session_names::SessionNameRef,
    ) -> Vec<String> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        shareds
            .into_iter()
            .filter(|shared| {
                shared
                    .lock()
                    .expect("terminal lock")
                    .name_ref
                    .as_ref()
                    .is_some_and(|bound| bound == name_ref)
            })
            .map(|shared| shared.lock().expect("terminal lock").terminal_id.clone())
            .collect()
    }

    /// `registry.list()` as consumed by the `/api/terminals` directory
    /// (`terminal-view/service.ts#listTerminalDirectory`): every registered
    /// terminal's raw record, including the reassembled scrollback snapshot the
    /// `lastLine` extraction reads. Unsorted — the router applies the original's
    /// `compareTerminals` (lastActivityAt desc, then terminalId desc).
    pub fn directory(&self) -> Vec<DirectoryEntry> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        shareds
            .iter()
            .map(|shared| {
                let s = shared.lock().expect("terminal lock");
                DirectoryEntry {
                    terminal_id: s.terminal_id.clone(),
                    title: s.title.clone(),
                    description: s.description.clone(),
                    mode: s.mode.clone(),
                    resume_session_id: s.resume_session_id.clone(),
                    created_at: s.created_at,
                    last_activity_at: s.last_activity_at,
                    status: s.status,
                    has_clients: !s.subscribers.is_empty(),
                    cwd: s.cwd.clone(),
                    snapshot: s.replay.iter().map(|f| f.output.data.as_str()).collect(),
                    name_ref: s.name_ref.clone(),
                    session_name: s.session_name.clone(),
                }
            })
            .collect()
    }

    /// Install or clear the asynchronous managed-runtime controller. The legacy
    /// server leaves this unset, preserving local PTY ownership byte-for-byte.
    pub fn set_managed_controller(&self, controller: Option<Arc<dyn ManagedTerminalController>>) {
        *self
            .managed_controller
            .write()
            .expect("managed controller lock") = controller;
    }

    pub fn has_managed_controller(&self) -> bool {
        self.managed_controller
            .read()
            .expect("managed controller lock")
            .is_some()
    }

    /// Per-connection creation capability latch. Existing managed rows keep
    /// their owner across reattach, regardless of this socket's capability.
    pub fn set_managed_runtime_connection(&self, conn_id: u64, enabled: bool) {
        let mut connections = self
            .managed_runtime_connections
            .lock()
            .expect("managed runtime connections lock");
        if enabled {
            connections.insert(conn_id);
        } else {
            connections.remove(&conn_id);
        }
    }

    pub fn managed_runtime_connection(&self, conn_id: u64) -> bool {
        self.managed_runtime_connections
            .lock()
            .expect("managed runtime connections lock")
            .contains(&conn_id)
    }

    /// Reconstruct a browser-facing facade from protected supervisor inventory
    /// before legacy pane reconciliation consults host-local provider stores.
    /// This is read/adopt only: it never launches or resumes a provider.
    pub async fn adopt_managed_for_reconcile(
        &self,
        terminal_id: &str,
        create_request_id: Option<String>,
    ) -> Result<bool, String> {
        if self.exists(terminal_id) {
            return Ok(self.is_managed(terminal_id));
        }
        let controller = self
            .managed_controller
            .read()
            .expect("managed controller lock")
            .clone();
        let Some(controller) = controller else {
            return Ok(false);
        };
        let Some(descriptor) = controller
            .lookup_terminal(terminal_id, create_request_id)
            .await?
        else {
            return Ok(false);
        };
        if descriptor.terminal_id != terminal_id {
            return Err(format!(
                "managed inventory returned terminal {} for requested {terminal_id}",
                descriptor.terminal_id
            ));
        }
        self.register_managed(descriptor);
        Ok(true)
    }

    pub fn managed_descriptor(&self, terminal_id: &str) -> Option<ManagedTerminalDescriptor> {
        self.inner
            .lock()
            .expect("registry lock")
            .terminals
            .get(terminal_id)
            .and_then(|handle| handle.managed.clone())
    }

    pub fn is_managed(&self, terminal_id: &str) -> bool {
        self.managed_descriptor(terminal_id).is_some()
    }

    /// The live managed facade that owns this exact provider identity, if any.
    ///
    /// A managed soul's provider state lives inside its own runtime volume,
    /// so the web server's host-local session index cannot adjudicate it. Pane
    /// reconciliation consults this first: the supervisor-owned row is the
    /// authority for its own identity, whatever a stale disk index believes.
    /// Only Running rows answer — a stopped facade owns nothing.
    pub fn live_managed_owner_for_session(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Option<ManagedTerminalDescriptor> {
        let inner = self.inner.lock().expect("registry lock");
        inner.terminals.values().find_map(|handle| {
            let descriptor = handle.managed.as_ref()?;
            if descriptor.mode != provider {
                return None;
            }
            if descriptor.resume_session_id.as_deref() != Some(session_id) {
                return None;
            }
            let running = handle
                .shared
                .lock()
                .ok()
                .is_some_and(|shared| shared.status == TerminalRunStatus::Running);
            running.then(|| descriptor.clone())
        })
    }

    /// Register the browser-facing facade for a supervisor-owned PTY. This row
    /// deliberately has no `PtyTerminal`: server shutdown therefore has no OS
    /// process handle it could accidentally reap.
    pub fn register_managed(&self, descriptor: ManagedTerminalDescriptor) {
        let created_at = now_ms();
        let shared = Arc::new(Mutex::new(TerminalShared {
            terminal_id: descriptor.terminal_id.clone(),
            stream_id: descriptor.stream_id.clone(),
            replay: VecDeque::new(),
            replay_chars: 0,
            max_replay_chars: self.scrollback_max_bytes().max(0) as usize,
            scanner: BarrierScanner::new(),
            modes: ModeTracker::new(),
            noise: NoiseScanner::new(),
            head_seq: 0,
            status: TerminalRunStatus::Running,
            exit_code: None,
            created_at,
            last_activity_at: created_at,
            last_output_activity_at: created_at,
            last_meaningful_activity_at: created_at,
            last_meaningful_output_at: created_at,
            stuck_since: None,
            cols: 120,
            rows: 30,
            geometry_epoch: 1,
            has_client_geometry: false,
            cwd: Some(descriptor.cwd.clone()),
            title: "Shell".to_string(),
            description: None,
            mode: descriptor.mode.clone(),
            resume_session_id: descriptor.resume_session_id.clone(),
            create_request_id: descriptor.create_request_id.clone(),
            subscribers: HashMap::new(),
            claims: BTreeSet::new(),
            // Managed terminal liveness is owned by the supervisor; a dropped
            // browser is never an idle-reap signal.
            released_by_client: false,
            name_ref: None,
            naming_handle: None,
            session_name: None,
        }));
        let mut inner = self.inner.lock().expect("registry lock");
        inner.terminals.insert(
            descriptor.terminal_id.clone(),
            TerminalHandle {
                shared,
                pty: None,
                managed: Some(descriptor),
                managed_read_in_flight: Arc::new(AtomicBool::new(false)),
            },
        );
        inner.revision += 1;
    }

    /// Merge one host-spooled output chunk into the ordinary replay/fan-out
    /// machinery. Re-reading the same host cursor is harmless: seqEnd <= head
    /// is dropped before it can be duplicated in replay.
    pub fn ingest_managed_output(
        &self,
        terminal_id: &str,
        seq_start: i64,
        seq_end: i64,
        data: String,
    ) -> bool {
        let (shared, stream_id) = {
            let inner = self.inner.lock().expect("registry lock");
            let Some(handle) = inner.terminals.get(terminal_id) else {
                return false;
            };
            if handle.managed.is_none() {
                return false;
            }
            let shared = Arc::clone(&handle.shared);
            let stream_id = handle
                .managed
                .as_ref()
                .map(|m| m.stream_id.clone())
                .unwrap_or_default();
            (shared, stream_id)
        };
        {
            let s = shared.lock().expect("terminal lock");
            if seq_end <= s.head_seq {
                return true;
            }
        }
        ingest(
            &shared,
            ServerMessage::TerminalOutput(TerminalOutput {
                data,
                seq_start,
                seq_end,
                stream_id,
                terminal_id: terminal_id.to_string(),
                attach_request_id: None,
                source: None,
            }),
        );
        true
    }

    pub fn managed_output_cursor(&self, terminal_id: &str) -> Option<i64> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            let handle = inner.terminals.get(terminal_id)?;
            handle.managed.as_ref()?;
            Arc::clone(&handle.shared)
        };
        let value = shared.lock().expect("terminal lock").head_seq;
        Some(value)
    }

    pub async fn launch_managed(
        &self,
        request: ManagedTerminalLaunch,
    ) -> Result<ManagedTerminalDescriptor, String> {
        let controller = self
            .managed_controller
            .read()
            .expect("managed controller lock")
            .clone()
            .ok_or_else(|| "managed runtime controller unavailable".to_string())?;
        controller.launch(request).await
    }

    pub async fn managed_input(&self, terminal_id: &str, data: String) -> Result<(), String> {
        let terminal = self
            .managed_descriptor(terminal_id)
            .ok_or_else(|| "managed terminal not found".to_string())?;
        let controller = self
            .managed_controller
            .read()
            .expect("managed controller lock")
            .clone()
            .ok_or_else(|| "managed runtime controller unavailable".to_string())?;
        controller.input(terminal, data).await
    }

    pub async fn managed_resize(
        &self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let terminal = self
            .managed_descriptor(terminal_id)
            .ok_or_else(|| "managed terminal not found".to_string())?;
        let controller = self
            .managed_controller
            .read()
            .expect("managed controller lock")
            .clone()
            .ok_or_else(|| "managed runtime controller unavailable".to_string())?;
        controller.resize(terminal, cols, rows).await
    }

    pub async fn managed_stop(&self, terminal_id: &str) -> Result<(), String> {
        let terminal = self
            .managed_descriptor(terminal_id)
            .ok_or_else(|| "managed terminal not found".to_string())?;
        let controller = self
            .managed_controller
            .read()
            .expect("managed controller lock")
            .clone()
            .ok_or_else(|| "managed runtime controller unavailable".to_string())?;
        controller.stop(terminal).await
    }

    /// Pull bounded host-spooled output and merge it into the ordinary
    /// terminal replay/fan-out path. The host is still the sole PTY reader;
    /// this is a control-plane read of already-drained output. The caller
    /// must associate any reported native session identity, then apply the
    /// reported exit with [`Self::finish_managed_exit`]. An output read can
    /// report both facts at once, and association requires a Running row.
    pub async fn refresh_managed_output(
        &self,
        terminal_id: &str,
        max_bytes: u64,
    ) -> Result<ManagedOutputRead, String> {
        let (terminal, flag) = {
            let inner = self.inner.lock().expect("registry lock");
            let handle = inner
                .terminals
                .get(terminal_id)
                .ok_or_else(|| "managed terminal not found".to_string())?;
            (
                handle
                    .managed
                    .clone()
                    .ok_or_else(|| "terminal is not managed".to_string())?,
                Arc::clone(&handle.managed_read_in_flight),
            )
        };
        let Some(claim) = ManagedReadClaim::acquire(flag) else {
            return Ok(ManagedOutputRead {
                stream_epoch: None,
                incarnation_id: None,
                reset_required: false,
                truncated: false,
                retained_from_seq: self.managed_output_cursor(terminal_id).unwrap_or(0),
                head_seq: self.managed_output_cursor(terminal_id).unwrap_or(0),
                exit_code: None,
                native_session_id: terminal.resume_session_id,
                chunks: Vec::new(),
            });
        };
        // The previous claimant may have completed after our first snapshot
        // but before acquisition. Read the descriptor only under our claim.
        let terminal = self
            .managed_descriptor(terminal_id)
            .ok_or_else(|| "managed terminal disappeared before read".to_string())?;
        let after_seq = self.managed_output_cursor(terminal_id).unwrap_or(0);
        let controller = self
            .managed_controller
            .read()
            .expect("managed controller lock")
            .clone()
            .ok_or_else(|| "managed runtime controller unavailable".to_string())?;
        let mut read = controller
            .read_output(terminal, after_seq, max_bytes)
            .await?;
        let mut announcements = Vec::new();
        let mut epoch_changed = false;
        {
            let mut inner = self.inner.lock().expect("registry lock");
            let handle = inner
                .terminals
                .get_mut(terminal_id)
                .ok_or_else(|| "managed facade disappeared during output read".to_string())?;
            if !Arc::ptr_eq(&claim.0, &handle.managed_read_in_flight) {
                return Err("managed facade was replaced during output read".into());
            }
            let descriptor = handle
                .managed
                .as_mut()
                .ok_or_else(|| "managed facade ownership changed during output read".to_string())?;
            // A terminal facade may learn the first provider-observed identity,
            // but recovery must never silently substitute another conversation.
            if let (Some(expected), Some(observed)) =
                (&descriptor.resume_session_id, &read.native_session_id)
            {
                if expected != observed {
                    return Err("managed output native identity mismatch".into());
                }
            }
            match (&read.stream_epoch, &read.incarnation_id) {
                (Some(epoch), Some(incarnation))
                    if !epoch.is_empty() && !incarnation.is_empty() =>
                {
                    epoch_changed = descriptor.stream_id != *epoch;
                }
                (None, None) if read.chunks.is_empty() && !read.reset_required => {}
                _ => return Err("managed output has incomplete source identity".into()),
            }
            let mut state = handle.shared.lock().expect("terminal lock");
            if epoch_changed || read.reset_required {
                state.replay.clear();
                state.replay_chars = 0;
                state.head_seq = read.retained_from_seq.saturating_sub(1);
                state.scanner = BarrierScanner::new();
                state.modes = ModeTracker::new();
                state.noise = NoiseScanner::new();
            }
            if epoch_changed {
                let epoch = read.stream_epoch.as_ref().expect("validated source epoch");
                descriptor.stream_id.clone_from(epoch);
                descriptor
                    .incarnation_id
                    .clone_from(read.incarnation_id.as_ref().expect("validated incarnation"));
                state.stream_id.clone_from(epoch);
                state.geometry_epoch = state.geometry_epoch.saturating_add(1);
                for subscriber in state.subscribers.values() {
                    announcements.push((
                        Arc::clone(&subscriber.sink),
                        ServerMessage::TerminalStreamChanged(TerminalStreamChanged {
                            reason: TerminalStreamChangedReason::NewPtySession,
                            stream_id: epoch.clone(),
                            terminal_id: terminal_id.to_string(),
                            attach_request_id: subscriber.attach_request_id.clone(),
                        }),
                    ));
                }
            }
            if let Some(native) = &read.native_session_id {
                descriptor.resume_session_id = Some(native.clone());
                state.resume_session_id = Some(native.clone());
            }
        }
        // Control announcements are emitted before any replacement frames. A
        // reattach in between observes the already-updated epoch in attach.ready.
        for (sink, message) in announcements {
            sink(message);
        }
        if epoch_changed || read.reset_required {
            read.reset_required = true;
            if let Some(first) = read.chunks.first_mut() {
                first.data = format!(
                    "\r\n[Terminal output resumed in a new retained window; earlier output may be truncated.]\r\n{}",
                    first.data
                );
            }
        }
        for chunk in &read.chunks {
            self.ingest_managed_output(
                terminal_id,
                chunk.seq_start,
                chunk.seq_end,
                chunk.data.clone(),
            );
        }
        Ok(read)
    }

    /// Managed equivalent of `finish_pty_exit`: the OS process is already
    /// gone and the supervisor-owned enclosure has been stopped; retain the
    /// facade/replay tail but mark it exited and tell attached viewers once.
    pub fn finish_managed_exit(&self, terminal_id: &str, exit_code: i64) -> bool {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            let Some(handle) = inner.terminals.get(terminal_id) else {
                return false;
            };
            if handle.managed.is_none() {
                return false;
            }
            Arc::clone(&handle.shared)
        };
        let mut state = shared.lock().expect("terminal lock");
        if state.status == TerminalRunStatus::Exited {
            return true;
        }
        state.status = TerminalRunStatus::Exited;
        state.exit_code = Some(exit_code);
        let now = now_ms();
        state.last_activity_at = now;
        state.last_output_activity_at = now;
        state.last_meaningful_activity_at = now;
        state.last_meaningful_output_at = now;
        let exit = ServerMessage::TerminalExit(TerminalExit {
            exit_code,
            terminal_id: terminal_id.to_string(),
        });
        // The host spool's final chunks were ingested before this transition.
        // A paced subscriber still has undelivered pages in the ring: stage
        // its exit until the replay drain completes, exactly as the local
        // PTY natural-exit path does.
        let mut staged_notify: Vec<PacedExitNotify> = Vec::new();
        let mut retire_now: Vec<u64> = Vec::new();
        for (conn_id, subscriber) in state.subscribers.iter_mut() {
            if subscriber.paced_deferred {
                subscriber.paced_exit_pending = Some(exit_code);
                if let Some(notify) = subscriber.paced_exit_notify.clone() {
                    staged_notify.push(notify);
                }
            } else {
                (subscriber.sink)(exit.clone());
                retire_now.push(*conn_id);
            }
        }
        for conn_id in retire_now {
            state.subscribers.remove(&conn_id);
        }
        drop(state);
        for notify in staged_notify {
            notify(terminal_id, exit_code);
        }
        self.release_session_ref_ownership(terminal_id, "registry/managed-exit");
        self.notify_activity(ActivityEvent::Exit {
            terminal_id: terminal_id.to_string(),
            at: now_ms(),
            spontaneous: true,
        });
        true
    }

    /// Managed terminal facades currently attached to one socket. Used by the
    /// WS poller to keep live output flowing without giving the web process a
    /// PTY reader or process handle.
    pub fn managed_attached_to(&self, conn_id: u64) -> Vec<String> {
        let inner = self.inner.lock().expect("registry lock");
        inner
            .terminals
            .iter()
            .filter_map(|(terminal_id, handle)| {
                let managed = handle.managed.as_ref()?;
                let state = handle.shared.lock().expect("terminal lock");
                if managed.terminal_id != *terminal_id {
                    tracing::error!(terminal_id = %terminal_id, descriptor_terminal_id = %managed.terminal_id,
                        "managed_terminal_descriptor_key_mismatch");
                    return None;
                }
                state.subscribers.contains_key(&conn_id).then(|| terminal_id.clone())
            })
            .collect()
    }

    /// Register a terminal record with NO backing PTY — see [`HeadlessTerminal`]
    /// for exactly who this seam exists for. The row (including its
    /// `create_request_id` stamp) is inserted atomically under the registry
    /// lock, same as [`Self::create`].
    pub fn register_headless(&self, opts: HeadlessTerminal) {
        let created_at = opts.created_at.unwrap_or_else(now_ms);
        let mode = if opts.mode.is_empty() {
            "shell".to_string()
        } else {
            opts.mode
        };
        let create_request_id = opts.create_request_id.clone();
        let shared = Arc::new(Mutex::new(TerminalShared {
            terminal_id: opts.terminal_id.clone(),
            stream_id: opts.stream_id,
            replay: VecDeque::new(),
            replay_chars: 0,
            max_replay_chars: self.scrollback_max_bytes().max(0) as usize,
            scanner: BarrierScanner::new(),
            modes: ModeTracker::new(),
            noise: NoiseScanner::new(),
            head_seq: 0,
            status: TerminalRunStatus::Running,
            exit_code: None,
            created_at,
            last_activity_at: created_at,
            last_output_activity_at: created_at,
            last_meaningful_activity_at: created_at,
            last_meaningful_output_at: created_at,
            stuck_since: None,
            cols: 120,
            rows: 30,
            geometry_epoch: 1,
            has_client_geometry: false,
            cwd: None,
            title: "Shell".to_string(),
            description: None,
            mode,
            resume_session_id: opts.resume_session_id,
            create_request_id,
            subscribers: HashMap::new(),
            claims: BTreeSet::new(),
            released_by_client: true,
            name_ref: None,
            naming_handle: None,
            session_name: None,
        }));
        {
            let mut inner = self.inner.lock().expect("registry lock");
            inner.terminals.insert(
                opts.terminal_id.clone(),
                TerminalHandle {
                    shared,
                    pty: None,
                    managed: None,
                    managed_read_in_flight: Arc::new(AtomicBool::new(false)),
                },
            );
            inner.revision += 1;
        }
        if let Some(key) = opts
            .create_request_id
            .or_else(|| self.probe_create_request_id(&opts.terminal_id))
        {
            self.warn_on_duplicate_live_ptys(&key);
        }
    }

    /// Terminals (of any status) matching a `createRequestId`, NEWEST
    /// generation first (`created_at` desc, `terminal_id` desc tie-break).
    fn terminals_by_create_request_id(&self, key: &str) -> Vec<(String, TerminalRunStatus)> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        let mut rows: Vec<(i64, String, TerminalRunStatus)> = shareds
            .iter()
            .filter_map(|shared| {
                let s = shared.lock().expect("terminal lock");
                if s.create_request_id.as_deref() == Some(key) {
                    Some((s.created_at, s.terminal_id.clone(), s.status))
                } else {
                    None
                }
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        rows.into_iter()
            .map(|(_, id, status)| (id, status))
            .collect()
    }

    /// The newest **live** terminal for a `createRequestId` — the idempotency
    /// keystone (design §7) and the single-flight create-dedupe key (§5.4).
    /// Exited generations are excluded; a key whose every generation has
    /// exited returns `None`.
    pub fn newest_live_by_create_request_id(&self, key: &str) -> Option<String> {
        self.terminals_by_create_request_id(key)
            .into_iter()
            .find(|(_, status)| *status == TerminalRunStatus::Running)
            .map(|(id, _)| id)
    }

    /// The newest terminal for a `createRequestId` INCLUDING exited
    /// generations — used by the verdict derivation (§5.2 step 2) to recover a
    /// retired terminal's identity before declaring `fresh`.
    pub fn newest_by_create_request_id(&self, key: &str) -> Option<String> {
        self.terminals_by_create_request_id(key)
            .into_iter()
            .next()
            .map(|(id, _)| id)
    }

    /// Whether a terminal is registered AND currently running (an exited-but-
    /// retained record is NOT live — contrast [`Self::is_running`], which only
    /// checks registration).
    pub fn is_live(&self, terminal_id: &str) -> bool {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        match shared {
            Some(shared) => {
                shared.lock().expect("terminal lock").status == TerminalRunStatus::Running
            }
            None => false,
        }
    }

    /// One terminal's [`IdentityProbeRow`] (mode / status / registry-side
    /// resume id) — the per-terminal getter the reconcile derivation uses to
    /// resolve identity across the crate boundary for REST-created resumes
    /// (design §2 assumption 1's acceptance check).
    pub fn probe(&self, terminal_id: &str) -> Option<IdentityProbeRow> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.map(|shared| {
            let s = shared.lock().expect("terminal lock");
            IdentityProbeRow {
                terminal_id: s.terminal_id.clone(),
                mode: s.mode.clone(),
                status: s.status,
                created_at: s.created_at,
                resume_session_id: s.resume_session_id.clone(),
                cwd: s.cwd.clone(),
            }
        })
    }

    /// A terminal's stamped `createRequestId`, if any.
    pub fn probe_create_request_id(&self, terminal_id: &str) -> Option<String> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.and_then(|shared| {
            shared
                .lock()
                .expect("terminal lock")
                .create_request_id
                .clone()
        })
    }

    /// kata b8ke Task 6: is this terminal's row GONE (the kill path removes
    /// rows) or no longer `Running` (the natural-exit path RETAINS the row as
    /// `Exited` via [`Self::finish_pty_exit`], which makes the death
    /// observable)? The handoff runner's bounded reap loop polls this
    /// predicate; it stays SYNC because this crate is tokio-free by design —
    /// the awaitable loop lives in the caller (`session_handoff.rs`).
    pub fn terminal_is_dead(&self, terminal_id: &str) -> bool {
        match self.probe(terminal_id) {
            None => true,
            Some(row) => row.status != TerminalRunStatus::Running,
        }
    }

    /// §5.4 single-flight claim: reserve `key` for an in-flight keyed create.
    /// `false` means another create currently holds the reservation — the
    /// caller should re-check for a live terminal (adopt) instead of
    /// spawning. Pair with [`Self::end_keyed_create`].
    pub fn begin_keyed_create(&self, key: &str) -> bool {
        self.keyed_create_inflight
            .lock()
            .expect("keyed-create inflight lock")
            .insert(key.to_string())
    }

    /// Release a [`Self::begin_keyed_create`] reservation (success OR failure
    /// — the spawn's outcome is discoverable via the registry itself).
    pub fn end_keyed_create(&self, key: &str) {
        self.keyed_create_inflight
            .lock()
            .expect("keyed-create inflight lock")
            .remove(key);
    }

    /// Same-id double-resume guard claim (see `resume_create_inflight`'s
    /// field doc): reserve a `"resume:{mode}:{sid}"` key for an in-flight
    /// resume-mode amplifier create (spawned as `amplifier session resume
    /// --full-history <id>`). `false` means another create currently holds
    /// it. Mirrors [`Self::begin_keyed_create`]; pair with
    /// [`Self::end_resume_create`].
    fn begin_resume_create(&self, key: &str) -> bool {
        self.resume_create_inflight
            .lock()
            .expect("resume-create inflight lock")
            .insert(key.to_string())
    }

    /// Release a [`Self::begin_resume_create`] reservation (success OR
    /// failure — mirrors [`Self::end_keyed_create`]).
    fn end_resume_create(&self, key: &str) {
        self.resume_create_inflight
            .lock()
            .expect("resume-create inflight lock")
            .remove(key);
    }

    /// Council rule 7 (D8): claim the one in-flight create slot for a
    /// sessionRef. Checks, in order:
    ///
    /// 1. A live terminal already carrying the ref
    ///    ([`Self::live_terminal_for_session_ref`]) or a recorded binding
    ///    whose terminal is not KNOWN dead → `BoundElsewhere` (attach to the
    ///    winner). A binding whose terminal is known dead (registered but
    ///    not Running) is pruned instead — a dead winner must not strand
    ///    losers.
    /// 2. A held, unexpired lease → `Held` (retry after
    ///    [`SESSION_RESERVED_RETRY_AFTER_MS`]).
    /// 3. A held lease past `acquired_at_ms + `[`SESSION_REF_LEASE_TTL_MS`]:
    ///    with a recorded pid → `ExpiredNeedsKill` (KILL-BEFORE-RELEASE: the
    ///    lease stays held until [`Self::force_release_after_confirmed_kill`]);
    ///    without one (holder hung pre-spawn, nothing to kill) → revoke the
    ///    lease, ERROR-log, and answer `Held` — hold closed, never release
    ///    what you can't kill.
    /// 4. Otherwise the slot is free → record the lease, `Acquired`.
    ///
    /// `now_ms` is caller-supplied wall-clock so tests never sleep.
    pub fn claim_session_ref(
        &self,
        locator: &SessionLocator,
        holder_create_request_id: &str,
        holder_conn: u64,
        now_ms: u64,
    ) -> SessionRefClaim {
        let key = session_ref_key(locator);

        // 1a. Row-join liveness: a live terminal already carries this ref.
        if let Some(terminal_id) = self.live_terminal_for_session_ref(locator) {
            return SessionRefClaim::BoundElsewhere { terminal_id };
        }

        // 1b. Recorded binding — honored unless its terminal is KNOWN dead
        // (a registered row that is no longer Running). Lock order: the
        // bindings mutex is held across the liveness probes, which take only
        // the registry `inner` + terminal locks; no path acquires bindings
        // while holding those, so the order is acyclic.
        {
            let mut bindings = self
                .session_ref_bindings
                .lock()
                .expect("session-ref bindings lock");
            if let Some(terminal_id) = bindings.get(&key).cloned() {
                let known_dead = self.is_running(&terminal_id) && !self.is_live(&terminal_id);
                if known_dead {
                    bindings.remove(&key);
                } else {
                    return SessionRefClaim::BoundElsewhere { terminal_id };
                }
            }
        }

        self.claim_session_ref_lease_phase(locator, holder_create_request_id, holder_conn, now_ms)
    }

    /// Lease phase of [`Self::claim_session_ref`] (steps 2-4: held /
    /// expired / free). Split out so the claim-side TOCTOU re-check
    /// (final review finding 1) can be pinned by a test that stages
    /// "loser passed checks 1a/1b before the winner registered" without
    /// threads: a full `claim_session_ref` call is always caught by step
    /// 1b while a binding exists, so only a direct entry here can
    /// exercise the under-lock re-check.
    fn claim_session_ref_lease_phase(
        &self,
        locator: &SessionLocator,
        holder_create_request_id: &str,
        holder_conn: u64,
        now_ms: u64,
    ) -> SessionRefClaim {
        let key = session_ref_key(locator);
        let mut leases = self
            .session_ref_leases
            .lock()
            .expect("session-ref lease lock");
        match leases.get_mut(&key) {
            None => {
                // Claim-side TOCTOU (final review finding 1): checks 1a/1b
                // ran BEFORE this lock was taken. A loser preempted across
                // the winner's register -> `complete_session_ref_claim`
                // window arrives here after complete removed the winner's
                // lease -- seeing no lease -- while only the bindings map
                // records the winner. Re-check bindings WHILE HOLDING the
                // leases lock: a recorded binding means a winner already
                // completed, so answer `BoundElsewhere` instead of
                // double-acquiring (a second spawn on one sessionRef is the
                // duplicate-writer shape D8 exists to close). Lock order
                // leases -> bindings matches `complete_session_ref_claim`
                // and is acyclic: step 1b's bindings block ends before the
                // leases lock is taken, and no path acquires the leases
                // lock while holding bindings. A binding observed here is
                // either freshly completed (live winner) or, if its winner
                // has since died, handled on the loser's retry claim, whose
                // step 1b prunes known-dead winners.
                let bound = self
                    .session_ref_bindings
                    .lock()
                    .expect("session-ref bindings lock")
                    .get(&key)
                    .cloned();
                if let Some(terminal_id) = bound {
                    return SessionRefClaim::BoundElsewhere { terminal_id };
                }
                leases.insert(
                    key,
                    SessionRefLease {
                        locator: locator.clone(),
                        holder_create_request_id: holder_create_request_id.to_string(),
                        holder_conn,
                        acquired_at_ms: now_ms,
                        pid: None,
                        revoked: false,
                    },
                );
                SessionRefClaim::Acquired
            }
            Some(lease) => {
                let expired = now_ms > lease.acquired_at_ms + session_ref_lease_ttl_ms();
                if !expired {
                    return SessionRefClaim::Held {
                        retry_after_ms: SESSION_RESERVED_RETRY_AFTER_MS,
                    };
                }
                match lease.pid {
                    Some(pid) => SessionRefClaim::ExpiredNeedsKill { pid },
                    None => {
                        if !lease.revoked {
                            lease.revoked = true;
                            tracing::error!(target: "invariant",
                                provider = %locator.provider,
                                session_id = %locator.session_id,
                                holder_create_request_id = %lease.holder_create_request_id,
                                acquired_at_ms = lease.acquired_at_ms,
                                now_ms,
                                "session_ref_lease_revoked: TTL expired on a pid-less holder; held closed");
                        }
                        SessionRefClaim::Held {
                            retry_after_ms: SESSION_RESERVED_RETRY_AFTER_MS,
                        }
                    }
                }
            }
        }
    }

    /// Record the holder's spawned child pid on its lease, arming the TTL
    /// expiry's `ExpiredNeedsKill` path. No-op if the lease is gone or held
    /// by a different `createRequestId`.
    pub fn set_session_ref_lease_pid(
        &self,
        locator: &SessionLocator,
        holder_create_request_id: &str,
        pid: u32,
    ) {
        let key = session_ref_key(locator);
        let mut leases = self
            .session_ref_leases
            .lock()
            .expect("session-ref lease lock");
        if let Some(lease) = leases.get_mut(&key) {
            if lease.holder_create_request_id == holder_create_request_id {
                lease.pid = Some(pid);
            }
        }
    }

    /// Spawn succeeded: record binding, release lease, run the duplicate alarm.
    /// Returns false if the lease was revoked while spawning (caller must kill
    /// its own child and fail the create loudly). A revoked lease is NOT
    /// released here — kill-before-release: the caller confirms its child's
    /// death, then calls [`Self::force_release_after_confirmed_kill`].
    pub fn complete_session_ref_claim(
        &self,
        locator: &SessionLocator,
        holder_create_request_id: &str,
        terminal_id: &str,
    ) -> bool {
        let key = session_ref_key(locator);
        {
            let mut leases = self
                .session_ref_leases
                .lock()
                .expect("session-ref lease lock");
            match leases.get(&key) {
                Some(lease)
                    if lease.holder_create_request_id == holder_create_request_id
                        && !lease.revoked =>
                {
                    leases.remove(&key);
                    // ATOMICITY (fix round 1, finding 2): the binding MUST be
                    // inserted while the leases lock is still held. Releasing
                    // the lease first and binding under a separate lock opens
                    // a window where a racing `claim_session_ref` sees no live
                    // row, no binding, and no lease -> `Acquired` -> a second
                    // spawn: the exact duplicate-writer race this primitive
                    // exists to close. Lock order leases -> bindings is
                    // acyclic: `claim_session_ref`'s bindings block ends
                    // before it takes the leases lock, and no other path
                    // acquires the leases lock while holding bindings.
                    self.session_ref_bindings
                        .lock()
                        .expect("session-ref bindings lock")
                        .insert(key, terminal_id.to_string());
                }
                _ => return false,
            }
        }
        self.alarm_if_duplicate_session_ref(locator);
        true
    }

    /// Spawn failed: release the holder's lease (no child exists — the spawn
    /// itself errored — so release is safe even for a revoked lease). No-op
    /// if the lease is gone or held by a different `createRequestId`.
    pub fn fail_session_ref_claim(&self, locator: &SessionLocator, holder_create_request_id: &str) {
        let key = session_ref_key(locator);
        let mut leases = self
            .session_ref_leases
            .lock()
            .expect("session-ref lease lock");
        if leases
            .get(&key)
            .is_some_and(|l| l.holder_create_request_id == holder_create_request_id)
        {
            leases.remove(&key);
        }
    }

    /// Connection death: release this conn's leases. Returns (locator_key, pid)
    /// pairs whose in-flight children the caller must kill (kill-before-release
    /// applies: entries WITH a pid are returned still-held; caller kills,
    /// confirms, then calls force_release_after_confirmed_kill).
    pub fn release_session_ref_leases_for_conn(
        &self,
        conn: u64,
    ) -> Vec<(SessionLocator, Option<u32>)> {
        let mut leases = self
            .session_ref_leases
            .lock()
            .expect("session-ref lease lock");
        let mut out = Vec::new();
        leases.retain(|_, lease| {
            if lease.holder_conn != conn {
                return true;
            }
            out.push((lease.locator.clone(), lease.pid));
            // pid-less: nothing spawned, release now. pid-carrying: keep held
            // until the caller confirms the kill (kill-before-release).
            lease.pid.is_some()
        });
        out
    }

    /// The caller killed the holder's child via the registry PTY handle and
    /// CONFIRMED death (ESRCH): release the lease so the next claim wins.
    /// kata b8ke Task 4: also force-release the COORDINATOR with the retained
    /// claim (fenced — no-op on any mismatch, never fires during a Handoff),
    /// so a confirmed-kill recovery path reopens BOTH layers.
    pub fn force_release_after_confirmed_kill(&self, locator: &SessionLocator) {
        self.session_ref_leases
            .lock()
            .expect("session-ref lease lock")
            .remove(&session_ref_key(locator));
        let Some(ownership) = self.ownership.as_ref() else {
            return;
        };
        // Take-if-matches: only an entry whose runtime is CONFIRMED DEAD (no
        // registry row — every confirmed kill removes it) is taken; a newer
        // LIVE owner's retained entry (same locator key, replaced at its
        // commit) is never taken by an older path's force-release.
        let key = session_ref_key(locator);
        let dead_runtime = {
            let claims = self
                .session_ref_ownership
                .lock()
                .expect("session-ref ownership lock");
            claims
                .get(&key)
                .is_some_and(|claim| !self.is_running(&claim.terminal_id))
        };
        if dead_runtime {
            if let Some(claim) = self.take_retained_ownership_claim(&key) {
                ownership.force_release_for_confirmed_kill(
                    &locator.provider,
                    &locator.session_id,
                    &freshell_ownership::ReleaseClaim {
                        operation_id: claim.operation_id.clone(),
                        generation: claim.generation,
                        runtime: Some(retained_runtime_identity(&claim)),
                    },
                    "registry/confirmed-kill",
                );
            }
        }
    }

    /// kata b8ke Task 4: commit coordinator ownership for a sessionRef-bound
    /// terminal — `Live{Terminal}` with the runtime identity (terminal id +
    /// current PTY pid) — and RETAIN the claim so the exit/kill release paths
    /// can release it fenced. Called by the create lanes (WS / REST /
    /// auto-resume) at their winner-settle points. Returns the coordinator's
    /// outcome: `Committed`, or `StaleGeneration`/`ForeignOperation` — the
    /// caller must tear down its just-spawned child exactly like its
    /// revoked-lease discipline (the key was never ours to keep).
    pub fn commit_session_ref_ownership(
        &self,
        locator: &SessionLocator,
        operation_id: &str,
        generation: u64,
        terminal_id: &str,
    ) -> freshell_ownership::CommitOutcome {
        let Some(ownership) = self.ownership.as_ref() else {
            return freshell_ownership::CommitOutcome::Committed;
        };
        // b8ke ext r9 F2: the commit verifies the spawned PTY is STILL
        // RUNNING at commit time — a fast-failing exact resume can exit
        // during the asynchronous binding and registration work BEFORE
        // this commit, and its natural-exit callback (finding no retained
        // claim yet) releases NOTHING; pre-r9 the dead terminal was then
        // recorded Live{Terminal}. The retained-claim lock is the ordering
        // point for the whole commit: the exit path flips the row's status
        // FIRST (under the registry's inner lock) and takes/releases the
        // retained claim second, so whichever observes first wins — the
        // commit under this lock either sees the still-Running row (it
        // commits and inserts; the exit callback's take then finds the
        // claim and releases it) or sees the already-Exited row and
        // fails typed (a dead runtime NEVER records Live). The nesting is
        // safe: no code path takes the registry's inner lock and then this
        // lock, so claims→inner can never invert.
        let mut claims = self
            .session_ref_ownership
            .lock()
            .expect("session-ref ownership lock");
        if !self.is_pty_running(terminal_id) {
            tracing::error!(target: "freshell_terminal",
                terminal_id = %terminal_id,
                provider = %locator.provider,
                session_id = %locator.session_id,
                operation_id = %operation_id,
                "session_ref_ownership_commit_refused_dead_pty: the PTY exited \
                 before the commit — a dead runtime is never recorded Live; the \
                 natural-exit path owns the release");
            return freshell_ownership::CommitOutcome::ForeignOperation;
        }
        let pid = self.pid_of(terminal_id);
        let owner = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some(terminal_id.to_string()),
            live_session_key: None,
            pid,
            ownership_id: Some(operation_id.to_string()),
        };
        let outcome = ownership.commit_live(
            &locator.provider,
            &locator.session_id,
            operation_id,
            generation,
            owner,
        );
        if matches!(outcome, freshell_ownership::CommitOutcome::Committed) {
            claims.insert(
                session_ref_key(locator),
                RetainedSessionRefOwnership {
                    locator: locator.clone(),
                    terminal_id: terminal_id.to_string(),
                    operation_id: operation_id.to_string(),
                    generation,
                    pid,
                },
            );
        }
        outcome
    }

    /// TEST FIXTURE ONLY (b8ke ext r9 F2): stamp a coordinator
    /// `Live{Terminal}` owner AND the retained claim for a terminal whose
    /// registry row is ALREADY GONE — the mid-kill-race shape (the commit
    /// landed while the row was alive; the reaper consumed the row before
    /// the kill observed it). Pre-r9 the public
    /// `commit_session_ref_ownership` could construct this shape because it
    /// verified nothing; it now refuses a dead/gone PTY typed, so the
    /// wedge-test fixtures seed the state directly. Never call from
    /// production code.
    #[doc(hidden)]
    pub fn seed_live_session_ref_ownership_for_test(
        &self,
        locator: &freshell_protocol::SessionLocator,
        operation_id: &str,
        generation: u64,
        terminal_id: &str,
    ) -> freshell_ownership::CommitOutcome {
        let Some(ownership) = self.ownership.as_ref() else {
            return freshell_ownership::CommitOutcome::Committed;
        };
        let owner = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some(terminal_id.to_string()),
            live_session_key: None,
            pid: None,
            ownership_id: Some(operation_id.to_string()),
        };
        let outcome = ownership.commit_live(
            &locator.provider,
            &locator.session_id,
            operation_id,
            generation,
            owner,
        );
        if matches!(outcome, freshell_ownership::CommitOutcome::Committed) {
            self.session_ref_ownership
                .lock()
                .expect("session-ref ownership lock")
                .insert(
                    session_ref_key(locator),
                    RetainedSessionRefOwnership {
                        locator: locator.clone(),
                        terminal_id: terminal_id.to_string(),
                        operation_id: operation_id.to_string(),
                        generation,
                        pid: None,
                    },
                );
        }
        outcome
    }

    /// b8ke ext r14 F2: the identity REBIND's commit — the ext-r9 F2
    /// liveness contract plus the atomic coordinator move
    /// ([`freshell_ownership::RuntimeOwnershipRegistry::commit_live_rekey_from_terminal`]:
    /// the new key's Starting claim commits Live while the OLD key's
    /// Live{Terminal} record becomes Aliased — ONE coordinator lock scope,
    /// never the interval where both keys name the writer) and the
    /// RETAINED CLAIM REKEY in one registry lock scope: the old key's
    /// retained claim is REMOVED as the new key's is inserted, so the
    /// kill/exit selection can never pick a stale old claim. The old
    /// claim is returned to the caller (the release of the old key is the
    /// caller's broadcast decision, not a second registry step).
    pub fn commit_session_ref_ownership_rekey(
        &self,
        old_locator: &freshell_protocol::SessionLocator,
        new_locator: &freshell_protocol::SessionLocator,
        operation_id: &str,
        generation: u64,
        terminal_id: &str,
    ) -> (
        freshell_ownership::CommitOutcome,
        Option<RetainedSessionRefOwnership>,
    ) {
        let Some(ownership) = self.ownership.as_ref() else {
            return (freshell_ownership::CommitOutcome::Committed, None);
        };
        // b8ke ext r30 F2: the retained-claim lock is the ordering point
        // for the WHOLE rekey — held across the liveness check, the
        // old→new coordinator move, AND the claim-map move, exactly the
        // normal commit's discipline (the template at
        // [`Self::commit_session_ref_ownership`]). Pre-r30 the rekey
        // checked liveness and moved the coordinator record BEFORE taking
        // this lock: a PTY exiting between the coordinator move and the
        // claim move was consumed by `finish_pty_exit` against the OLD
        // claim — releasing the now-Aliased old key (a no-op) — and the
        // rekey then installed a NEW claim for the already-dead terminal,
        // leaving the new canonical key falsely Live{Terminal} with no
        // release evidence. Under this lock an exit in the window BLOCKS
        // and consumes the NEW claim once the rekey completes (releasing
        // the new key correctly), and an exit that already happened is
        // seen by the liveness check (a dead PTY never rebinds). The
        // nesting is the template's own: no code path takes the registry's
        // inner lock and then this lock, so claims→inner can never invert.
        let mut claims = self
            .session_ref_ownership
            .lock()
            .expect("session-ref ownership lock");
        // The ext-r9 F2 commit-time liveness check: a dead/gone PTY never
        // records Live (the association lanes gate on a Running row, so
        // this passes).
        if !self.is_pty_running(terminal_id) {
            tracing::error!(target: "freshell_terminal",
                terminal_id = %terminal_id,
                provider = %new_locator.provider,
                session_id = %new_locator.session_id,
                operation_id = %operation_id,
                "session_ref_ownership_rekey_refused_dead_pty: the PTY exited \
                 before the rebind commit — a dead runtime is never recorded \
                 Live; the rebind mutates nothing");
            return (freshell_ownership::CommitOutcome::ForeignOperation, None);
        }
        let pid = self.pid_of(terminal_id);
        let owner = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some(terminal_id.to_string()),
            live_session_key: None,
            pid,
            ownership_id: Some(operation_id.to_string()),
        };
        let outcome = ownership.commit_live_rekey_from_terminal(
            &new_locator.provider,
            &new_locator.session_id,
            operation_id,
            generation,
            &old_locator.session_id,
            terminal_id,
            owner,
            "ws-identity-association/rebind",
        );
        if !matches!(outcome, freshell_ownership::CommitOutcome::Committed) {
            return (outcome, None);
        }
        // b8ke ext r30 F1's test seam: the deterministic park INSIDE the
        // critical section — between the coordinator move and the
        // claim-map move. Never armed in production.
        #[cfg(test)]
        REKEY_INTERLOCK.wait_if_targeted(terminal_id);
        // The retained-claim rekey: remove the old claim + insert the new
        // — ONE registry lock scope (the map never holds both after the
        // step) — and now ATOMIC with the coordinator move above (the
        // same lock scope covers both).
        let removed_old = claims.remove(&session_ref_key(old_locator));
        claims.insert(
            session_ref_key(new_locator),
            RetainedSessionRefOwnership {
                locator: new_locator.clone(),
                terminal_id: terminal_id.to_string(),
                operation_id: operation_id.to_string(),
                generation,
                pid,
            },
        );
        (outcome, removed_old)
    }

    /// b8ke ext r14 F2 (test probe): the retained ownership claim a
    /// locator holds, if any — the rebind's claim-rekey assertions read
    /// the map without depending on HashMap iteration order.
    pub fn retained_ownership_claim_by_locator(
        &self,
        locator: &freshell_protocol::SessionLocator,
    ) -> Option<RetainedSessionRefOwnership> {
        self.session_ref_ownership
            .lock()
            .expect("session-ref ownership lock")
            .get(&session_ref_key(locator))
            .cloned()
    }

    /// b8ke ext r14 F2: remove a locator's retained ownership claim — the
    /// rebind's old-key half of the retained-claim rekey (the kill/exit
    /// selection must never find a superseded claim beside its
    /// replacement). Returns the removed claim, if any.
    pub fn remove_retained_session_ref_claim(
        &self,
        locator: &freshell_protocol::SessionLocator,
    ) -> Option<RetainedSessionRefOwnership> {
        self.session_ref_ownership
            .lock()
            .expect("session-ref ownership lock")
            .remove(&session_ref_key(locator))
    }

    /// The last-known coordinator `(epoch, generation)` a terminal committed
    /// under (kata b8ke Task 4) — the auto-resume crash event's observed
    /// fence pair. `None` when the terminal never committed ownership (a
    /// pre-coordinator terminal, or one whose locator resolved later).
    pub fn retained_ownership_fence(&self, terminal_id: &str) -> Option<(u64, u64)> {
        let ownership = self.ownership.as_ref()?;
        let claims = self
            .session_ref_ownership
            .lock()
            .expect("session-ref ownership lock");
        claims
            .values()
            .find(|claim| claim.terminal_id == terminal_id)
            .map(|claim| (ownership.boot_epoch(), claim.generation))
    }

    /// The retained coordinator claim for a terminal (kata b8ke Task 4) —
    /// the explicit-kill path's `StopClaim` source (expected runtime
    /// identity + observed fence).
    pub fn retained_ownership_claim(
        &self,
        terminal_id: &str,
    ) -> Option<RetainedSessionRefOwnership> {
        let claims = self
            .session_ref_ownership
            .lock()
            .expect("session-ref ownership lock");
        claims
            .values()
            .find(|claim| claim.terminal_id == terminal_id)
            .cloned()
    }

    /// Take the retained claim keyed by the locator key (the force-release
    /// twin's lookup). Removing the entry hands the release decision to the
    /// caller; a mismatched Live record still no-ops the fenced release.
    fn take_retained_ownership_claim(&self, key: &str) -> Option<RetainedSessionRefOwnership> {
        self.session_ref_ownership
            .lock()
            .expect("session-ref ownership lock")
            .remove(key)
    }

    /// Take the retained claim belonging to THIS terminal (the exit/kill
    /// release paths' lookup). Only an entry whose terminal id matches is
    /// taken — a newer owner's retained entry (same locator key, replaced at
    /// its commit) is never taken by an older terminal's death.
    fn take_retained_ownership_claims_for_terminal(
        &self,
        terminal_id: &str,
    ) -> Vec<RetainedSessionRefOwnership> {
        // b8ke ext r14 F2: take EVERY claim this terminal holds — the
        // kill/exit owns the TERMINAL, so each of its retained claims
        // releases its key (a rebind's superseded old claim beside its new
        // one must never leave the new key stranded by unordered
        // HashMap selection). Pre-r14 this took exactly ONE matching
        // claim: a rebind-left pair let the iteration order pick the
        // stale old claim, releasing the already-vacant old key while the
        // authoritative new key stayed Live after the terminal died.
        let mut claims = self
            .session_ref_ownership
            .lock()
            .expect("session-ref ownership lock");
        let matching: Vec<String> = claims
            .iter()
            .filter(|(_, claim)| claim.terminal_id == terminal_id)
            .map(|(key, _)| key.clone())
            .collect();
        matching
            .into_iter()
            .filter_map(|key| claims.remove(&key))
            .collect()
    }

    /// The failed-handoff restore's claim repair (kata b8ke whole-branch
    /// review M-1): a prior TERMINAL owner restored as Live carries the
    /// RECORD's current (handoff-bumped) generation, so the retained claim
    /// its exit/kill release paths fence with must be bumped to the SAME
    /// generation — otherwise the fenced `release`/
    /// `force_release_for_confirmed_kill` (an exact generation match
    /// against the Live state) would no-op forever and the restored key
    /// would never vacate when the terminal dies. Only the generation moves:
    /// the locator, terminal id, committing operation id, and pid stay the
    /// prior's own (the identity the restored Live record holds). Returns
    /// whether a claim for this terminal was found and bumped. A restore
    /// only ever happens while the terminal's row is still Running (a
    /// killed row fails the liveness re-probe), so the claim is present in
    /// every reachable shape — unlike the fresh lanes' stamp (which the
    /// lane kill TAKES while the runtime can stay alive), the terminal
    /// claim is only ever consumed by paths that remove the row.
    pub fn repair_restored_prior_ownership(&self, terminal_id: &str, generation: u64) -> bool {
        let mut claims = self
            .session_ref_ownership
            .lock()
            .expect("session-ref ownership lock");
        let Some(claim) = claims
            .values_mut()
            .find(|claim| claim.terminal_id == terminal_id)
        else {
            return false;
        };
        claim.generation = generation;
        true
    }

    /// The fenced coordinator release for a terminal's confirmed death (kata
    /// b8ke Task 4): no-ops when unwired, when the terminal never committed,
    /// or when the retained claim no longer matches the Live record (a newer
    /// owner took the key — its entry is never taken).
    fn release_session_ref_ownership(&self, terminal_id: &str, initiator: &str) {
        let Some(ownership) = self.ownership.as_ref() else {
            return;
        };
        // b8ke ext r14 F2: EVERY retained claim this terminal held
        // releases its key — a mismatched (already-moved/vacant) key
        // no-ops per the release-claim discipline, so taking all is
        // always safe and never strands a key by selection order.
        for claim in self.take_retained_ownership_claims_for_terminal(terminal_id) {
            ownership.release(
                &claim.locator.provider,
                &claim.locator.session_id,
                &freshell_ownership::ReleaseClaim {
                    operation_id: claim.operation_id.clone(),
                    generation: claim.generation,
                    runtime: Some(retained_runtime_identity(&claim)),
                },
                initiator,
            );
        }
    }

    /// The terminalId a completed claim bound this sessionRef to
    /// ([`Self::complete_session_ref_claim`]), if any — the read side of the
    /// registry binding map (Task 6 winner bind; also a test probe).
    pub fn bound_terminal_for_session_ref(&self, locator: &SessionLocator) -> Option<String> {
        self.session_ref_bindings
            .lock()
            .expect("session-ref bindings lock")
            .get(&session_ref_key(locator))
            .cloned()
    }

    /// The live child pid behind `terminal_id`'s PTY handle (unix only;
    /// `None` for headless/exited terminals). Task 6: the winner records this
    /// on its sessionRef lease ([`Self::set_session_ref_lease_pid`]).
    pub fn pid_of(&self, terminal_id: &str) -> Option<u32> {
        let inner = self.inner.lock().expect("registry lock");
        inner
            .terminals
            .get(terminal_id)
            .and_then(|h| h.pty.as_ref())
            .and_then(|p| p.pid())
    }

    /// The terminal whose PTY handle carries `pid`. The kill-before-release
    /// paths (lease TTL expiry, holder conn death) must kill through the
    /// REGISTRY handle ([`Self::kill`] → group-kill discipline, `pty.rs`) —
    /// NEVER a raw single-pid SIGKILL — so they resolve the recorded pid back
    /// to its owning terminal first.
    pub fn live_terminal_for_pid(&self, pid: u32) -> Option<String> {
        let inner = self.inner.lock().expect("registry lock");
        inner.terminals.iter().find_map(|(id, h)| {
            (h.pty.as_ref().and_then(|p| p.pid()) == Some(pid)).then(|| id.clone())
        })
    }

    /// §5.4 backstop detector (always-on, capability-independent): if a key
    /// now has two or more LIVE terminals, make it loud — two live PTYs on one
    /// `createRequestId` means two JSONL writers on one session file.
    fn warn_on_duplicate_live_ptys(&self, key: &str) {
        let live: Vec<String> = self
            .terminals_by_create_request_id(key)
            .into_iter()
            .filter(|(_, status)| *status == TerminalRunStatus::Running)
            .map(|(id, _)| id)
            .collect();
        if live.len() >= 2 {
            tracing::warn!(
                create_request_id = %key,
                terminal_ids = ?live,
                "ws.reconcile.duplicate_pty"
            );
        }
    }

    /// Live terminal ids currently carrying this sessionRef via the
    /// registry-row join: `mode == locator.provider &&
    /// resume_session_id == Some(locator.session_id) && status Running`,
    /// newest generation first (`created_at` desc, `terminal_id` desc
    /// tie-break, mirroring [`Self::terminals_by_create_request_id`]).
    ///
    /// LOOKUP DESIGN (validator-corrected): registry rows have NO dedicated
    /// `session_ref` field ([`TerminalShared::inventory`] hardcodes
    /// `session_ref: None`), so row identity IS this join. Rows are one of
    /// the TWO identity stores — the other is `freshell-ws`'s identity
    /// registry, which this crate cannot see (dep direction) — so ws-side
    /// callers consult both.
    fn live_terminal_ids_for_session_ref(&self, locator: &SessionLocator) -> Vec<String> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        let mut rows: Vec<(i64, String)> = shareds
            .iter()
            .filter_map(|shared| {
                let s = shared.lock().expect("terminal lock");
                if s.status == TerminalRunStatus::Running
                    && s.mode == locator.provider
                    && s.resume_session_id.as_deref() == Some(locator.session_id.as_str())
                {
                    Some((s.created_at, s.terminal_id.clone()))
                } else {
                    None
                }
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        rows.into_iter().map(|(_, id)| id).collect()
    }

    /// Council rule 6: the live terminal (newest first) currently carrying
    /// this sessionRef, if any — the reconcile derivation and the create-path
    /// lease (Tasks 5/6) attach every other client's claim for the same ref
    /// to this winner, regardless of `createRequestId`.
    pub fn live_terminal_for_session_ref(&self, locator: &SessionLocator) -> Option<String> {
        self.live_terminal_ids_for_session_ref(locator)
            .into_iter()
            .next()
    }

    /// D7 live-session guard predicate, shared by the WS `terminal.create`
    /// path (`freshell-ws/src/terminal.rs`) and the REST spawn pipeline
    /// (`freshell-freshagent/src/terminal_tabs.rs`): returns the terminal_id
    /// of a currently-RUNNING terminal that already owns `(mode, session_id)`,
    /// if any. Two arms, exactly the WS guard's join (see commit d9b71f50):
    /// 1. identity arm: the injected identity store's owner, probed Running;
    /// 2. row arm: any directory row with this mode + resume_session_id, Running.
    ///
    /// `identity: None` (e.g. the seam is unwired) narrows to the row arm.
    pub fn live_session_owner(
        &self,
        identity: Option<&dyn SessionIdentityLookup>,
        mode: &str,
        session_id: &str,
    ) -> Option<String> {
        if let Some(owner_tid) = identity
            .and_then(|ident| ident.terminal_for_session(mode, session_id))
            .filter(|tid| {
                self.probe(tid)
                    .is_some_and(|r| r.status == TerminalRunStatus::Running)
            })
        {
            return Some(owner_tid);
        }
        self.directory().into_iter().find_map(|entry| {
            (entry.mode == mode
                && entry.resume_session_id.as_deref() == Some(session_id)
                && entry.status == TerminalRunStatus::Running)
                .then_some(entry.terminal_id)
        })
    }

    /// Council rule 9, D8 backstop: >=2 live PTYs carrying one sessionRef is
    /// the two-writers corruption shape. Alarm loudly (ERROR-level invariant
    /// log); never kill silently. Returns whether the invariant is violated.
    pub fn alarm_if_duplicate_session_ref(&self, locator: &SessionLocator) -> bool {
        let live = self.live_terminal_ids_for_session_ref(locator);
        if live.len() >= 2 {
            tracing::error!(target: "invariant",
                provider = %locator.provider,
                session_id = %locator.session_id,
                live = live.len(),
                terminal_ids = ?live,
                "duplicate_pty_for_session_ref: >=2 live PTYs share one sessionRef");
            return true;
        }
        false
    }

    /// The current `terminals.changed.revision` (run-monotonic, `§7.5`).
    pub fn revision(&self) -> i64 {
        self.inner.lock().expect("registry lock").revision
    }

    /// Whether a terminal is currently registered (running). For teardown assertions.
    pub fn is_running(&self, terminal_id: &str) -> bool {
        self.inner
            .lock()
            .expect("registry lock")
            .terminals
            .contains_key(terminal_id)
    }

    /// True only while the terminal's PTY is still running. Unlike the
    /// presence-only `exists()`/`is_running`, this goes false when the
    /// terminal exits naturally, even though the record is retained for
    /// restore/replay. Drives create-dedupe eviction: legacy parity with
    /// the Node server's delete-at-exit requestId pruning.
    pub fn is_pty_running(&self, terminal_id: &str) -> bool {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get(terminal_id) {
                Some(handle) => Arc::clone(&handle.shared),
                None => return false,
            }
        };
        let s = shared.lock().expect("terminal lock");
        s.status == TerminalRunStatus::Running
    }
}

/// Same-id double-resume guard (launcher-assigned amplifier identity plan):
/// does any RUNNING terminal of `mode` already carry `session_id` as its
/// resume id? Amplifier has no upstream concurrency guard — two live PTYs
/// resuming one session id would interleave writes into one session dir.
/// Shared here so both the WS create path (`freshell-ws`) and the REST
/// create path (`freshell-freshagent`) apply the identical predicate.
/// NOTE: this is the friendly PRE-CHECK only — the race-free enforcement
/// lives inside [`TerminalRegistry::create`] (validated fix F5).
pub fn has_live_resume(rows: &[IdentityProbeRow], mode: &str, session_id: &str) -> bool {
    rows.iter().any(|row| {
        row.mode == mode
            && row.status == TerminalRunStatus::Running
            && row.resume_session_id.as_deref() == Some(session_id)
    })
}

/// [`has_live_resume`] EXCLUDING one terminal id — the exit-hook stub-GC
/// guard (validated fix F5/V7's GC-vs-second-resume race): "is another live
/// terminal (not me) currently resuming this session id?" Used by both
/// exit hooks before deleting a never-used stub.
pub fn has_other_live_resume(
    rows: &[IdentityProbeRow],
    mode: &str,
    session_id: &str,
    excluding_terminal_id: &str,
) -> bool {
    rows.iter().any(|row| {
        row.terminal_id != excluding_terminal_id
            && row.mode == mode
            && row.status == TerminalRunStatus::Running
            && row.resume_session_id.as_deref() == Some(session_id)
    })
}

/// The reader-thread sink body (`onTerminalOutputRaw` → append + live flush,
/// `broker.ts:777-826`): classify the produced frame with the persistent barrier
/// scanner, store it in the replay log, and fan it out — stamped with each
/// subscriber's `attachRequestId` — to every attached connection, as
/// `terminal.output` (legacy) or `terminal.output.batch` (batch-capable).
fn ingest(shared: &Arc<Mutex<TerminalShared>>, msg: ServerMessage) {
    let ServerMessage::TerminalOutput(frame) = msg else {
        return;
    };
    let mut s = shared.lock().expect("terminal lock");
    s.head_seq = s.head_seq.max(frame.seq_end);
    s.last_activity_at = now_ms();
    // Episode-3 focused review r2: EVERY output frame — noise or not —
    // refreshes the output-only RAW activity clock the stuck sweep's
    // freshness conjunct reads. Keystrokes (`input`) and the teardown
    // grace bumps never touch it: only real PTY output can prove a pane
    // is still repainting, so typing at a quiet pane cannot manufacture
    // wedge freshness (`keypress_does_not_manufacture_wedge_freshness`).
    s.last_output_activity_at = s.last_activity_at;
    // DEV-0009: only genuinely-new content refreshes the idle-kill reap
    // clock. Spinner repaints / ticking counters / status-bar redraws still
    // bump the wire-visible last_activity_at above (terminal-core.md §1.3
    // holds for every consumer except the reaper) but must not exempt a
    // detached terminal from enforce_idle_kills forever. The same arm also
    // refreshes the wedge-backstop MEANINGFUL output clock — genuine output
    // is the ONLY thing that may un-wedge a stuck pane (episode-3 focused
    // review: keystrokes refresh the reaper clock alone, never this one).
    if s.noise.observe(&frame.data) {
        s.last_meaningful_activity_at = s.last_activity_at;
        s.last_meaningful_output_at = s.last_activity_at;
    }

    // Classify with the persistent per-terminal scanner (state persists across frames,
    // `replay-ring.ts:62-79`). Non-truncated frames (every graded chunk) classify by
    // the scan result directly.
    let classification = s.scanner.scan(&frame.data);
    // Mode replay-sync projection: scan the SAME decoded frame data (never
    // re-decode bytes) so a later surface-reset attach can synthesize the
    // emulator-mode preamble. Stateless wrt framing; stateful across frames.
    s.modes.scan(&frame.data);
    let retained = RetainedFrame {
        output: frame,
        barrier: classification.barrier,
        barrier_reason: classification.reason,
        state_before: classification.state_before,
        state_after: classification.state_after,
    };
    let terminal_id = s.terminal_id.clone();

    // Fan out LIVE per-subscriber. Batch-capable subscribers (cap + attachRequestId)
    // receive `terminal.output.batch`; everyone else the legacy `terminal.output`
    // (source stays 'live'). A single live frame is one small batch — the merge logic
    // is the same as replay's (proven byte-exact by the deterministic crate goldens).
    for sub in s.subscribers.values() {
        // Restore contract (responsive-terminal-restore): a subscriber with a
        // paced session in flight receives NOTHING inline — the retained
        // ring is the staging and the session's pages deliver its range in
        // seq order (see `Subscriber::paced_deferred`).
        if sub.paced_deferred {
            continue;
        }
        match (
            sub.terminal_output_batch_v1,
            sub.attach_request_id.as_deref(),
        ) {
            (true, Some(arid)) => {
                deliver_batches(
                    &sub.sink,
                    &terminal_id,
                    std::slice::from_ref(&retained),
                    arid,
                    "live",
                );
            }
            _ => {
                let mut f = retained.output.clone();
                f.attach_request_id = sub.attach_request_id.clone();
                (sub.sink)(ServerMessage::TerminalOutput(f));
            }
        }
    }

    // Retain canonical (unstamped) for future replay; whole-frame FIFO eviction past
    // the char cap (keep at least one frame). Counts **UTF-16 code units**
    // (`utf16_len`), matching legacy `ChunkRingBuffer`'s `this.size += chunk.length`
    // -- NOT UTF-8 bytes -- so a box-drawing/unicode-heavy session evicts at the
    // same rate as an ASCII session under the identical configured
    // `terminal.scrollback` cap.
    s.replay_chars += utf16_len(&retained.output.data).max(0) as usize;
    s.replay.push_back(retained);
    while s.replay_chars > s.max_replay_chars && s.replay.len() > 1 {
        if let Some(old) = s.replay.pop_front() {
            s.replay_chars -= utf16_len(&old.output.data).max(0) as usize;
        }
    }
}

/// Build `terminal.output.batch` wire payloads from a run of classified frames and
/// deliver them to one subscriber's sink (`broker.ts:1315-1343` flush → batch path).
/// A batch payload deserializes into `ServerMessage::TerminalOutputBatch`; an oversize
/// single-segment fallback deserializes into `ServerMessage::TerminalOutput`.
fn deliver_batches(
    sink: &FrameSink,
    terminal_id: &str,
    frames: &[RetainedFrame],
    attach_request_id: &str,
    source: &str,
) -> u64 {
    if frames.is_empty() {
        return 0;
    }
    let batch_max = terminal_stream_batch_max_bytes() as i64;
    let inputs: Vec<BatchInputFrame> = frames.iter().map(|f| f.to_batch_input()).collect();
    let batches = build_terminal_output_batches(&BatchBuildInput {
        frames: &inputs,
        max_serialized_bytes: batch_max,
        max_total_serialized_bytes: None,
        terminal_id: terminal_id.to_string(),
        attach_request_id: Some(attach_request_id.to_string()),
        source: Some(source.to_string()),
    });
    let mut serialized_bytes = 0u64;
    for batch in &batches {
        for payload in
            build_batch_wire_payloads(terminal_id, batch, attach_request_id, source, batch_max)
        {
            // The wire payload is exact JSON (camelCase, `type`-tagged); it round-trips
            // into the frozen `ServerMessage` variant it names.
            if let Ok(msg) = serde_json::from_value::<ServerMessage>(payload) {
                serialized_bytes +=
                    serde_json::to_string(&msg).map(|j| j.len()).unwrap_or(0) as u64;
                sink(msg);
            }
        }
    }
    serialized_bytes
}

// ── Paced replay page production (responsive-terminal-restore, W1) ──────────

/// The completing hold's fixed-boundary finish (round-4, plan:146): the
/// session's own window — everything up to the FIXED completion boundary
/// B — is delivered (the chunk `build` just sank), and the deferral clears
/// ATOMICALLY in this same lock hold. The frames the producer staged past
/// B (`back` bounds the retained tail, read from the ring — never the
/// terminal's current head) are NOT swept: a one-hold ring-sized
/// admission is a pinned replay backlog outside every page budget
/// (plan:145). A quiet terminal (nothing staged past B) completes cleanly
/// — post-hold ingests fan out directly at their own ingest, so the
/// boundary can neither lose nor duplicate a frame. A producing terminal
/// completes AT B with the exact residual interval declared as the
/// bounds-carrying `handoff_boundary_reached` delivery gap (retained and
/// fetchable — the client's bounded baseline recovery, the queue_overflow
/// repair contract, fetches it as a fresh bounded paced session).
fn complete_at_fixed_boundary(
    s: &mut TerminalShared,
    conn_id: u64,
    boundary: i64,
    back: (i64, i64),
    end_seq: i64,
    serialized_bytes: u64,
) -> PacedTailCompletion {
    let oldest = s.oldest_retained_seq();
    let sub = s.subscribers.get_mut(&conn_id).expect("subscriber present");
    if back.0 > boundary {
        // A residual exists past the boundary: declare its EXACT interval.
        let sink = Arc::clone(&sub.sink);
        let arid = sub.attach_request_id.clone();
        sink(ServerMessage::TerminalOutputGap(TerminalOutputGap {
            terminal_id: s.terminal_id.clone(),
            stream_id: s.stream_id.clone(),
            attach_request_id: arid,
            from_seq: boundary + 1,
            to_seq: back.1,
            reason: TerminalOutputGapReason::HandoffBoundaryReached,
            head_seq: Some(back.1),
            oldest_retained_seq: Some(oldest),
        }));
        sub.paced_deferred = false;
        sub.paced_handoff_boundary = None;
        // Finding F1: the staged exit rides the completing hold — ordered
        // after the residual gap frame, then the subscriber retires.
        deliver_staged_paced_exit(s, conn_id);
        return PacedTailCompletion::GapCompleted {
            lost_from: boundary + 1,
            lost_to: back.1,
            end_seq,
            serialized_bytes,
            // The ordinary fixed-boundary residual exit (round-5 finding
            // 3's diagnostics discriminator): RETAINED, fetchable loss.
            reason: PacedGapExitReason::HandoffBoundaryResidual,
        };
    }
    sub.paced_deferred = false;
    sub.paced_handoff_boundary = None;
    deliver_staged_paced_exit(s, conn_id);
    PacedTailCompletion::Completed {
        end_seq,
        serialized_bytes,
    }
}

/// E2R3 test-support: the subscriber-relevant subset of
/// `finish_pty_exit`'s STAGING, under a terminal lock the caller already
/// holds (the decision-path hook site) or has just acquired (the public
/// [`TerminalRegistry::stage_natural_exit_for_test`]). The deterministic
/// transition-race tests stage at a precise point through this twin
/// instead of a real PTY death (whose staging moment would be
/// uncontrolled); the real invariants are exercised by the
/// `finish_pty_exit` tests. Mirrors the production staging's shape: the
/// terminal flips to naturally `Exited` (monotone — a later real exit is
/// inert) and the exit code stages on the DEFERRED subscriber only.
fn stage_natural_exit_locked(s: &mut TerminalShared, conn_id: u64, exit_code: i64) -> bool {
    if s.status == TerminalRunStatus::Exited {
        return false; // monotone, once-only — the terminal is already dead
    }
    match s.subscribers.get_mut(&conn_id) {
        Some(sub) if sub.paced_deferred => {}
        _ => return false, // gone, or a non-deferred subscriber never stages
    }
    s.status = TerminalRunStatus::Exited;
    s.exit_code = Some(exit_code);
    s.subscribers
        .get_mut(&conn_id)
        .expect("subscriber present")
        .paced_exit_pending = Some(exit_code);
    true
}

/// Round-2 finding F1: deliver a subscriber's STAGED natural exit, if
/// any, in the same lock hold that just cleared its deferral — the sink
/// is the connection queue (per-terminal FIFO), so the exit leases
/// strictly AFTER everything this hold sank (the final pages and any
/// gap frames), and the subscriber retires exactly like
/// `finish_pty_exit`'s immediate arm retired its non-paced peers. No-op
/// when nothing is staged (the ordinary completion paths stay
/// byte-identical).
fn deliver_staged_paced_exit(s: &mut TerminalShared, conn_id: u64) -> Option<i64> {
    let code = s.subscribers.get(&conn_id)?.paced_exit_pending?;
    let sink = Arc::clone(&s.subscribers.get(&conn_id)?.sink);
    sink(ServerMessage::TerminalExit(TerminalExit {
        exit_code: code,
        terminal_id: s.terminal_id.clone(),
    }));
    s.subscribers.remove(&conn_id);
    tracing::info!(
        terminal_id = %s.terminal_id,
        conn_id,
        exit_code = code,
        "terminal.paced_exit_delivered"
    );
    Some(code)
}

/// One built page: its ascending wire messages, the last seq it covers (the
/// session's new production cursor), and the page's total serialized bytes.
struct PacedPageBuild {
    messages: Vec<ServerMessage>,
    end_seq: i64,
    serialized_bytes: u64,
}

/// The last sequence covered by a page wire message.
fn page_last_seq(msg: &ServerMessage) -> Option<i64> {
    match msg {
        ServerMessage::TerminalOutput(o) => Some(o.seq_end),
        ServerMessage::TerminalOutputBatch(b) => Some(b.seq_end),
        _ => None,
    }
}

/// Conservative per-frame wire-segment estimate for the batch projection:
/// `{"seqStart":N,"seqEnd":M,"endOffset":E,"rawFrameCount":C}` plus the
/// `serializedBytes` field's share. The exact per-segment wire size for
/// realistic seq widths (≤11 digits — a frame per millisecond for a year)
/// stays under this, so a walk that stops at the budget never undercounts.
const SEGMENT_WIRE_OVERHEAD_ESTIMATE: i64 = 96;

/// Fixed part of the once-per-batch envelope delta over the legacy
/// scaffold for the `terminal.output.batch` wire projection: the `.batch`
/// type suffix (7), the `,"serializedBytes":` key (20), and the
/// `,"segments":[` + `]` array wrapper (14). The variable part — the
/// digits of `serializedBytes` itself — is bounded by
/// [`crate::batch::digit_count`] of the page budget for any page that fits
/// it, so the walk charges `41 + digits(budget)` per batch-mode frame.
/// Charged on EVERY batch-mode frame because every produced batch contains
/// at least one frame (a multi-batch page — e.g. barrier-separated frames —
/// pays one envelope PER batch): merged frames were already over-charged
/// their full standalone envelope, so this only narrows their slack.
const BATCH_ENVELOPE_FIXED_BYTES: i64 = 41;

/// Select and project ONE bounded, ascending page of the
/// `(from_seq, to_seq_inclusive]` window for `conn_id`'s subscriber. The
/// caller holds the terminal lock; frames are selected BEFORE cloning (no
/// full-ring snapshot per page). Packing accounts every frame at its
/// STANDALONE envelope cost (the batch builder's own accounting, reusing
/// `measure_serialized_json_bytes` via the incremental scaffold), plus the
/// batch-segment overhead and the once-per-batch envelope delta
/// (`serializedBytes` + the `segments[]` wrapper + the `.batch` type
/// suffix) on batch-capable subscribers — an overestimate of the merged
/// wire cost, so every produced page's real serialized bytes stay within
/// the budget. A single frame whose own envelope exceeds the budget forms
/// its own atomic single-frame page (guaranteed progress; the oversize
/// result is explicit, never silently coalesced). That arm is
/// UNREACHABLE under supported settings (round-2 finding F2): the
/// fragment splitter's cap is clamped to
/// [`crate::fragment::PACED_PAGE_BUDGET_FLOOR_BYTES`] — the smallest page
/// budget any supported queue setting can produce — so a production
/// frame can never exceed the page budget; the arm is retained as
/// defense-in-depth for the unsupported residue.
fn paced_page_build(
    s: &TerminalShared,
    conn_id: u64,
    from_seq: i64,
    to_seq_inclusive: i64,
    budget: i64,
    source: OutputSource,
) -> Option<PacedPageBuild> {
    let sub = s.subscribers.get(&conn_id)?;
    let batch_mode = sub.terminal_output_batch_v1 && sub.attach_request_id.is_some();
    let arid = sub.attach_request_id.clone();
    let source_str = match source {
        OutputSource::Replay => "replay",
        OutputSource::Live => "live",
    };
    // The batch-mode per-frame charge adds the once-per-batch envelope
    // delta: a page that fits the budget serializes every payload at or
    // under it, so its `serializedBytes` digits never exceed
    // `digit_count(budget)` (an over-budget page is the explicit atomic
    // oversize result, which is allowed to exceed).
    let batch_mode_charge = if batch_mode {
        SEGMENT_WIRE_OVERHEAD_ESTIMATE
            + BATCH_ENVELOPE_FIXED_BYTES
            + crate::batch::digit_count(budget.max(0)) as i64
    } else {
        0
    };

    // First ring index with seq_start > from_seq (the ring is seq-ascending;
    // binary search avoids an O(ring) scan per page).
    let (mut lo, mut hi) = (0usize, s.replay.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if s.replay[mid].output.seq_start <= from_seq {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let start = lo;
    if start >= s.replay.len() || s.replay[start].output.seq_start > to_seq_inclusive {
        return None;
    }
    let scaffold = crate::batch::legacy_envelope_scaffold_bytes(
        &s.terminal_id,
        &s.replay[start].output.stream_id,
        arid.as_deref(),
        Some(source_str),
    ) as i64;

    let mut selected: Vec<RetainedFrame> = Vec::new();
    let mut page_bytes: i64 = 0;
    let mut end_seq = from_seq;
    // `range` starts at the binary-searched index in O(1) (unlike
    // `iter().skip`, which re-advances from the ring's front).
    for f in s.replay.range(start..) {
        if f.output.seq_start > to_seq_inclusive {
            break;
        }
        let escaped = crate::batch::json_escaped_len(&f.output.data) as i64;
        let digits = (crate::batch::digit_count(f.output.seq_start)
            + crate::batch::digit_count(f.output.seq_end)) as i64;
        let cost = scaffold + digits + escaped + batch_mode_charge;
        if selected.is_empty() {
            // Always include the first frame: an over-budget frame forms
            // its own atomic single-frame page.
            selected.push(f.clone());
            page_bytes = cost;
            end_seq = f.output.seq_end;
            if cost > budget {
                break;
            }
            continue;
        }
        if page_bytes + cost > budget {
            break;
        }
        selected.push(f.clone());
        page_bytes += cost;
        end_seq = f.output.seq_end;
    }

    // Project the selected frames the same way the inline paths deliver them.
    let messages: Vec<ServerMessage> = if batch_mode {
        build_batch_messages(
            &s.terminal_id,
            &selected,
            arid.as_deref().unwrap_or(""),
            source_str,
        )
    } else {
        selected
            .iter()
            .map(|f| {
                let mut out = f.output.clone();
                out.attach_request_id = arid.clone();
                out.source = Some(source);
                ServerMessage::TerminalOutput(out)
            })
            .collect()
    };
    let serialized_bytes = messages
        .iter()
        .map(|m| serde_json::to_string(m).map(|j| j.len()).unwrap_or(0))
        .sum::<usize>() as u64;
    Some(PacedPageBuild {
        messages,
        end_seq,
        serialized_bytes,
    })
}

/// The page projection's batch arm: `terminal.output.batch` wire payloads for
/// a bounded page selection (same builder + repacking as
/// [`deliver_batches`], which keeps its per-payload streaming shape for the
/// legacy inline path; pages are budget-bounded, so materializing their
/// messages is bounded by the page budget).
fn build_batch_messages(
    terminal_id: &str,
    frames: &[RetainedFrame],
    attach_request_id: &str,
    source: &str,
) -> Vec<ServerMessage> {
    if frames.is_empty() {
        return Vec::new();
    }
    let batch_max = terminal_stream_batch_max_bytes() as i64;
    let inputs: Vec<BatchInputFrame> = frames.iter().map(|f| f.to_batch_input()).collect();
    let batches = build_terminal_output_batches(&BatchBuildInput {
        frames: &inputs,
        max_serialized_bytes: batch_max,
        max_total_serialized_bytes: None,
        terminal_id: terminal_id.to_string(),
        attach_request_id: Some(attach_request_id.to_string()),
        source: Some(source.to_string()),
    });
    let mut messages = Vec::new();
    for batch in &batches {
        for payload in
            build_batch_wire_payloads(terminal_id, batch, attach_request_id, source, batch_max)
        {
            if let Ok(msg) = serde_json::from_value::<ServerMessage>(payload) {
                messages.push(msg);
            }
        }
    }
    messages
}

/// b8ke ext r30 F2 (test-only): the rekey's deterministic INTERLOCK —
/// parks the rekey's critical section between the old→new coordinator
/// move and the retained-claim move for ONE targeted terminal id, so a
/// test can drive the PTY-exit race in that exact window. Targeted by
/// terminal id so concurrent tests pass through untouched.
#[cfg(test)]
pub(crate) static REKEY_INTERLOCK: RekeyInterlock = RekeyInterlock {
    target: std::sync::Mutex::new(None),
    reached: std::sync::atomic::AtomicBool::new(false),
    gate: std::sync::Mutex::new(false),
    cv: std::sync::Condvar::new(),
};

#[cfg(test)]
pub(crate) struct RekeyInterlock {
    target: std::sync::Mutex<Option<String>>,
    reached: std::sync::atomic::AtomicBool,
    gate: std::sync::Mutex<bool>,
    cv: std::sync::Condvar,
}

#[cfg(test)]
impl RekeyInterlock {
    /// Arm the park for one terminal id — only that id parks. Re-arming
    /// resets the arrival flag.
    pub(crate) fn arm(&self, terminal_id: &str) {
        *self.target.lock().expect("interlock target") = Some(terminal_id.to_string());
        self.reached
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Has the targeted rekey reached the park?
    pub(crate) fn reached(&self) -> bool {
        self.reached.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Release the parked rekey and disarm (idempotent).
    pub(crate) fn release(&self) {
        *self.target.lock().expect("interlock target") = None;
        let mut gate = self.gate.lock().expect("interlock gate");
        *gate = true;
        self.cv.notify_all();
    }

    fn wait_if_targeted(&self, terminal_id: &str) {
        let targeted = self
            .target
            .lock()
            .expect("interlock target")
            .as_ref()
            .is_some_and(|t| t == terminal_id);
        if !targeted {
            return;
        }
        self.reached
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut gate = self.gate.lock().expect("interlock gate");
        while !*gate {
            gate = self.cv.wait(gate).expect("interlock condvar");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── DIAG-01 lifecycle tracing events ─────────────────────────────────
    //
    // A minimal capturing `tracing_subscriber::Layer` (dev-dependency only)
    // that records every event's message + string-rendered fields, installed
    // as the THREAD's default subscriber (`tracing::subscriber::set_default`,
    // scoped to the returned guard) rather than the process-global one --
    // `freshell-server`'s `logging::init` owns that (frozen, out of scope
    // here). This proves the lifecycle events fire with the documented
    // fields; the JSONL formatting itself is `freshell-server`'s concern.
    mod tracing_capture {
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::span::Attributes;
        use tracing::{Event, Id, Subscriber};
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::Layer;

        #[derive(Debug, Clone, Default)]
        pub struct CapturedEvent {
            pub message: String,
            pub fields: BTreeMap<String, String>,
        }

        #[derive(Default)]
        struct FieldVisitor {
            message: String,
            fields: BTreeMap<String, String>,
        }

        impl Visit for FieldVisitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                let rendered = format!("{value:?}");
                if field.name() == "message" {
                    self.message = rendered;
                } else {
                    self.fields.insert(field.name().to_string(), rendered);
                }
            }

            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "message" {
                    self.message = value.to_string();
                } else {
                    self.fields
                        .insert(field.name().to_string(), value.to_string());
                }
            }

            fn record_i64(&mut self, field: &Field, value: i64) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }

            fn record_u64(&mut self, field: &Field, value: u64) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }

            fn record_bool(&mut self, field: &Field, value: bool) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
        }

        struct CaptureLayer {
            events: Arc<Mutex<Vec<CapturedEvent>>>,
        }

        impl<S> Layer<S> for CaptureLayer
        where
            S: Subscriber,
        {
            fn on_new_span(&self, _attrs: &Attributes<'_>, _id: &Id, _ctx: Context<'_, S>) {}

            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = FieldVisitor::default();
                event.record(&mut visitor);
                self.events
                    .lock()
                    .expect("capture lock")
                    .push(CapturedEvent {
                        message: visitor.message,
                        fields: visitor.fields,
                    });
            }
        }

        /// Install a thread-local capturing subscriber for the life of the
        /// returned guard. `#[test]` functions run synchronously on their own
        /// test-harness thread, so this reliably observes every `tracing`
        /// event emitted by (synchronous) registry calls made while the
        /// guard is held.
        ///
        /// Parallel-capture flake fix (pre-existing on this branch): a
        /// capture's `Dispatch::new` and first-time `tracing` callsite
        /// registrations rebuild the process-wide callsite Interest cache,
        /// and a rebuild that resolves `get_default()` on a thread with no
        /// subscriber consults the global `NoSubscriber` — caching
        /// `Interest::never()` and silently dropping later events that the
        /// emitting test's own thread-local subscriber WOULD have captured
        /// (observed as an intermittent `terminal.killed` miss in
        /// `enforce_idle_kills_emits_killed_by_idle_and_a_sweep_summary_event`,
        /// roughly one failure per 4-6 parallel runs, reproduced on the
        /// pre-remediation baseline). Two defenses, by construction:
        ///  * a bare no-op global `Registry` is installed once — every
        ///    `get_default()` fallback and every JustOne-path rebuild then
        ///    consults a subscriber that answers `Interest::always()`, so a
        ///    `never` cache can never be minted anywhere in the process;
        ///  * each capture forces a rebuild with its own thread default
        ///    already installed, so no window opens on a stale cache.
        pub fn capture() -> (
            Arc<Mutex<Vec<CapturedEvent>>>,
            tracing::subscriber::DefaultGuard,
        ) {
            static GLOBAL_SINK: std::sync::Once = std::sync::Once::new();
            GLOBAL_SINK.call_once(|| {
                let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry());
            });
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            let guard = tracing::subscriber::set_default(subscriber);
            tracing::callsite::rebuild_interest_cache();
            (events, guard)
        }
    }

    /// **RED before implementation**: `TerminalRegistry::create` must emit a
    /// `terminal.created` tracing event (fields: `terminal_id`, `mode`, `cwd`,
    /// `pid`) -- DIAG-01's terminal lifecycle slice.
    #[test]
    fn create_emits_terminal_created_event_with_expected_fields() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-diag-created".to_string(),
            "S-diag-created".to_string(),
            "shell",
            None,
            None,
            None,
            None,
        )
        .expect("spawn /bin/sh -c 'sleep 30'");

        let captured = events.lock().unwrap();
        let created = captured
            .iter()
            .find(|e| e.message == "terminal.created")
            .expect("expected a terminal.created tracing event");
        assert_eq!(
            created.fields.get("terminal_id").map(String::as_str),
            Some("T-diag-created")
        );
        assert_eq!(
            created.fields.get("mode").map(String::as_str),
            Some("shell")
        );
        assert_eq!(created.fields.get("cwd").map(String::as_str), Some("/tmp"));
        assert!(
            created.fields.contains_key("pid"),
            "terminal.created must carry the spawned PTY's pid"
        );

        drop(captured);
        reg.kill("T-diag-created");
    }

    /// **RED (2026-07-22 incident)**: the `terminal.created` tracing event used
    /// to hardcode `mode = "shell"` (and the initial record's mode/resume) no
    /// matter what was actually launched -- during the codex-resume incident it
    /// reported six resumed-with-`resume <id>`-expected codex panes as plain
    /// shells, actively misleading the forensic investigation. The event (and
    /// the record, from birth -- no stamping window) must carry the REAL mode
    /// and whether a resume id was applied.
    #[test]
    fn create_emits_terminal_created_event_with_real_mode_and_resume() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-diag-created-codex".to_string(),
            "S-diag-created-codex".to_string(),
            "codex",
            Some("sess-codex-resume-1"),
            None,
            None,
            None,
        )
        .expect("spawn /bin/sh -c 'sleep 30'");

        let captured = events.lock().unwrap();
        let created = captured
            .iter()
            .find(|e| e.message == "terminal.created")
            .expect("expected a terminal.created tracing event");
        assert_eq!(
            created.fields.get("mode").map(String::as_str),
            Some("codex"),
            "the created event must log the REAL mode, not a hardcoded 'shell'"
        );
        assert_eq!(
            created.fields.get("resume_applied").map(String::as_str),
            Some("true"),
            "the created event must say whether resume args were applied"
        );
        drop(captured);

        // The record itself carries the real mode/resume from birth -- no
        // misleading window before the WS handler's `set_meta` stamps them.
        let rows = reg.identity_probe_rows();
        let row = rows
            .iter()
            .find(|r| r.terminal_id == "T-diag-created-codex")
            .expect("registry lists the created terminal");
        assert_eq!(row.mode, "codex");
        assert_eq!(
            row.resume_session_id.as_deref(),
            Some("sess-codex-resume-1")
        );

        reg.kill("T-diag-created-codex");
    }

    /// **RED before implementation**: `TerminalRegistry::finish_pty_exit`
    /// (the NATURAL-exit path) must emit a `terminal.exited` event (fields:
    /// `terminal_id`, `exit_code`).
    /// b8ke ext r30 F2: the rekey's exit race, driven deterministically
    /// through the interlock. The rekey parks INSIDE its critical section
    /// — between the old→new coordinator move and the retained-claim
    /// move — and the PTY's natural exit (`finish_pty_exit`) fires in
    /// that exact window. With the claims lock held across the whole
    /// rekey (the normal commit's template), the exit BLOCKS until the
    /// rekey completes, then consumes the NEW claim and releases the NEW
    /// canonical key: the new key is never falsely Live and no claim
    /// survives for the dead terminal. Pre-r30 the exit consumed the OLD
    /// claim mid-window (releasing the now-Aliased old key — a no-op),
    /// and the rekey then installed a NEW claim for the already-dead
    /// terminal, leaving the new canonical key falsely Live{Terminal}.
    #[test]
    fn rekey_exit_racing_the_claim_move_consumes_the_new_claim_and_releases_the_new_key() {
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let reg = TerminalRegistry::new().with_ownership(ownership.clone());
        reg.insert_headless("T-r30-rekey", "S-r30-rekey");

        let old_locator = SessionLocator {
            provider: "codex".to_string(),
            session_id: "ses-r30-old".to_string(),
        };
        let new_locator = SessionLocator {
            provider: "codex".to_string(),
            session_id: "ses-r30-new".to_string(),
        };

        // The old key's Live{Terminal} era: a begin + the normal commit
        // (the template) installs the old retained claim.
        let freshell_ownership::BeginOutcome::Granted { generation: g1 } = ownership.begin_start(
            &old_locator.provider,
            &old_locator.session_id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r30-old",
            None,
            "test",
            1_000,
        ) else {
            panic!("the old-key start must grant")
        };
        assert_eq!(
            reg.commit_session_ref_ownership(&old_locator, "op-r30-old", g1, "T-r30-rekey"),
            freshell_ownership::CommitOutcome::Committed
        );
        assert!(reg
            .retained_ownership_claim_by_locator(&old_locator)
            .is_some());

        // The new key's rekey entry: its Starting claim.
        let freshell_ownership::BeginOutcome::Granted { generation: g2 } = ownership.begin_start(
            &new_locator.provider,
            &new_locator.session_id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r30-new",
            None,
            "test",
            2_000,
        ) else {
            panic!("the new-key start must grant")
        };

        // Arm the interlock and run the rekey to its park — inside the
        // window, after the coordinator move, before the claim move.
        REKEY_INTERLOCK.arm("T-r30-rekey");
        let rekey_reg = reg.clone();
        let rekey_old = old_locator.clone();
        let rekey_new = new_locator.clone();
        let rekey = std::thread::spawn(move || {
            rekey_reg.commit_session_ref_ownership_rekey(
                &rekey_old,
                &rekey_new,
                "op-r30-new",
                g2,
                "T-r30-rekey",
            )
        });
        {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !REKEY_INTERLOCK.reached() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the rekey never reached the interlock park"
                );
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }

        // THE EXIT fires in the parked window. With the claims lock held
        // (the fix) it blocks mid-consumption; without it (pre-r30) it
        // consumed the OLD claim and no-op-released the aliased old key.
        let exit_reg = reg.clone();
        let exit = std::thread::spawn(move || exit_reg.finish_pty_exit("T-r30-rekey", 0));
        std::thread::sleep(std::time::Duration::from_millis(200));

        // Release the rekey: it completes the claim move under the lock,
        // and the (blocked) exit then consumes the NEW claim.
        REKEY_INTERLOCK.release();
        let (outcome, _removed_old) = rekey.join().expect("the rekey joins");
        assert_eq!(outcome, freshell_ownership::CommitOutcome::Committed);
        assert!(exit.join().expect("the exit joins"));

        // THE CONVERGENCE: the exit consumed the NEW claim and released
        // the NEW canonical key — never falsely Live — and no retained
        // claim survives for the dead terminal.
        let settled = ownership.observe(&new_locator.provider, &new_locator.session_id);
        assert!(
            !matches!(
                settled.state,
                freshell_ownership::OwnershipState::Live { .. }
            ),
            "the new canonical key is never falsely Live for the dead \
             terminal: {settled:?}"
        );
        assert!(
            reg.retained_ownership_claim_by_locator(&new_locator)
                .is_none(),
            "no retained claim survives the exit (the NEW claim was consumed)"
        );
        assert!(
            reg.retained_ownership_claim_by_locator(&old_locator)
                .is_none(),
            "the old claim never survived the rekey either"
        );
    }

    #[test]
    fn finish_pty_exit_emits_terminal_exited_event_with_exit_code() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-diag-exit", "S-diag-exit");

        assert!(reg.finish_pty_exit("T-diag-exit", 3));

        let captured = events.lock().unwrap();
        let exited = captured
            .iter()
            .find(|e| e.message == "terminal.exited")
            .expect("expected a terminal.exited tracing event");
        assert_eq!(
            exited.fields.get("terminal_id").map(String::as_str),
            Some("T-diag-exit")
        );
        assert_eq!(
            exited.fields.get("exit_code").map(String::as_str),
            Some("3")
        );
    }

    /// kata b8ke Task 6: the handoff runner's terminal-reap probe. A Running
    /// row is NOT dead; the kill path REMOVES the row (dead); the natural-exit
    /// path RETAINS it as `Exited` (dead — `finish_pty_exit`'s row retention
    /// makes the death observable); an unknown id is dead.
    #[test]
    fn terminal_is_dead_reports_running_alive_and_both_death_shapes_dead() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-dead-running", "S-1");
        reg.insert_headless("T-dead-exited", "S-2");
        reg.insert_headless("T-dead-killed", "S-3");

        assert!(
            !reg.terminal_is_dead("T-dead-running"),
            "a Running row is alive"
        );

        assert!(
            reg.finish_pty_exit("T-dead-exited", 0),
            "natural exit retains the row"
        );
        assert!(
            reg.terminal_is_dead("T-dead-exited"),
            "a retained Exited row is dead"
        );

        assert!(reg.kill("T-dead-killed"));
        assert!(
            reg.terminal_is_dead("T-dead-killed"),
            "a killed (removed) row is dead"
        );

        assert!(
            reg.terminal_is_dead("T-dead-never-existed"),
            "an unknown id is dead"
        );
    }

    /// **RED before implementation**: `TerminalRegistry::kill` must emit a
    /// `terminal.killed` event (fields: `terminal_id`, `by`), and the
    /// idle-reaper sweep must ADDITIONALLY emit a summary `terminal.idle_reap`
    /// event (field: `count`) -- but only when it actually killed something.
    #[test]
    fn enforce_idle_kills_emits_killed_by_idle_and_a_sweep_summary_event() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-diag-idle", "S-diag-idle");
        reg.set_auto_kill_idle_minutes(5);
        reg.backdate_last_activity("T-diag-idle", now_ms() - 6 * 60_000);

        let killed = reg.enforce_idle_kills();
        assert_eq!(killed, vec!["T-diag-idle".to_string()]);

        let captured = events.lock().unwrap();
        let killed_evt = captured
            .iter()
            .find(|e| {
                e.message == "terminal.killed"
                    && e.fields.get("terminal_id").map(String::as_str) == Some("T-diag-idle")
            })
            .expect("expected a terminal.killed tracing event for the idle victim");
        assert_eq!(
            killed_evt.fields.get("by").map(String::as_str),
            Some("idle")
        );

        let sweep = captured
            .iter()
            .find(|e| e.message == "terminal.idle_reap")
            .expect("expected a terminal.idle_reap sweep-summary event");
        assert_eq!(sweep.fields.get("count").map(String::as_str), Some("1"));
    }

    /// A sweep that kills nothing must NOT emit the summary event (the task
    /// spec: "idle-reap sweep (count killed, only when >0)").
    #[test]
    fn enforce_idle_kills_emits_no_sweep_event_when_nothing_was_killed() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-diag-fresh", "S-diag-fresh");
        reg.set_auto_kill_idle_minutes(5);
        // Freshly created -- not idle long enough to be a candidate.

        let killed = reg.enforce_idle_kills();
        assert!(killed.is_empty());

        let captured = events.lock().unwrap();
        assert!(
            !captured.iter().any(|e| e.message == "terminal.idle_reap"),
            "a no-op sweep must not emit terminal.idle_reap"
        );
    }
    use std::sync::Mutex as StdMutex;

    /// A `FrameSink` that records every delivered message for assertions.
    fn collector() -> (FrameSink, Arc<StdMutex<Vec<ServerMessage>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let seen2 = Arc::clone(&seen);
        let sink: FrameSink = Arc::new(move |msg| seen2.lock().unwrap().push(msg));
        (sink, seen)
    }

    fn frame(seq: i64, data: &str, stream_id: &str) -> TerminalOutput {
        TerminalOutput {
            data: data.to_string(),
            seq_start: seq,
            seq_end: seq,
            stream_id: stream_id.to_string(),
            terminal_id: "T".to_string(),
            attach_request_id: None,
            source: Some(OutputSource::Live),
        }
    }

    impl TerminalRegistry {
        /// Register a headless terminal (no PTY) so the stream logic can be driven
        /// deterministically by [`feed`](Self::feed) instead of real child output.
        fn insert_headless(&self, terminal_id: &str, stream_id: &str) {
            self.insert_headless_at(terminal_id, stream_id, now_ms());
        }

        /// Round-2 finding F1 test seam: this subscriber's staged exit
        /// code, if a natural exit staged one behind an armed deferral
        /// (None when the subscriber is gone or nothing is staged).
        /// Delegates to the real accessor the ws layer sequences on
        /// (E2R1 finding 1's [`TerminalRegistry::staged_paced_exit`]).
        fn paced_exit_pending_of(&self, terminal_id: &str, conn_id: u64) -> Option<i64> {
            self.staged_paced_exit(terminal_id, conn_id)
        }

        /// Same as [`insert_headless`](Self::insert_headless), but with an
        /// explicit `created_at` instead of the wall clock. Needed by tests that
        /// must pin two terminals to the SAME timestamp (e.g. exercising
        /// `inventory()`'s tie-break) without racing real `now_ms()` resolution
        /// under load -- see `inventory_lists_running_terminals_sorted_and_reflects_revision`.
        fn insert_headless_at(&self, terminal_id: &str, stream_id: &str, created_at: i64) {
            self.register_headless(HeadlessTerminal {
                terminal_id: terminal_id.to_string(),
                stream_id: stream_id.to_string(),
                mode: "shell".to_string(),
                resume_session_id: None,
                create_request_id: None,
                created_at: Some(created_at),
            });
        }

        /// Test-only: force a terminal's `lastActivityAt` AND every derived
        /// activity clock (the reaper's `last_meaningful_activity_at` AND
        /// the stuck sweep's two output-only clocks —
        /// `last_output_activity_at` and `last_meaningful_output_at`) to
        /// an arbitrary value so idle-kill and stuck sweep tests don't
        /// need to sleep for real minutes.
        fn backdate_last_activity(&self, terminal_id: &str, last_activity_at: i64) {
            let inner = self.inner.lock().unwrap();
            let handle = inner.terminals.get(terminal_id).unwrap();
            let mut s = handle.shared.lock().unwrap();
            s.last_activity_at = last_activity_at;
            s.last_output_activity_at = last_activity_at;
            s.last_meaningful_activity_at = last_activity_at;
            s.last_meaningful_output_at = last_activity_at;
        }

        /// Simulate the reader thread producing one frame (append + fan-out).
        fn feed(&self, terminal_id: &str, frame: TerminalOutput) {
            let shared = {
                let inner = self.inner.lock().unwrap();
                Arc::clone(&inner.terminals.get(terminal_id).unwrap().shared)
            };
            ingest(&shared, ServerMessage::TerminalOutput(frame));
        }
    }

    fn outputs(seen: &Arc<StdMutex<Vec<ServerMessage>>>) -> Vec<TerminalOutput> {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some(o.clone()),
                _ => None,
            })
            .collect()
    }

    fn attach_ready(seen: &Arc<StdMutex<Vec<ServerMessage>>>) -> Option<TerminalAttachReady> {
        seen.lock().unwrap().iter().find_map(|m| match m {
            ServerMessage::TerminalAttachReady(r) => Some(r.clone()),
            _ => None,
        })
    }

    fn batches(
        seen: &Arc<StdMutex<Vec<ServerMessage>>>,
    ) -> Vec<freshell_protocol::TerminalOutputBatch> {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutputBatch(b) => Some(b.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn batch_capability_gates_output_framing_legacy_stays_default() {
        // The T1 no-regression invariant AT THE REGISTRY: a subscriber that does NOT
        // negotiate the capability receives legacy per-frame `terminal.output`; one that
        // DOES receives `terminal.output.batch` — and both reassemble to identical bytes.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Background scrollback (replayed on attach).
        reg.feed("T", frame(1, "hello ", "S"));
        reg.feed("T", frame(2, "world\r\n", "S"));

        // (a) legacy subscriber (no capability) — must get `terminal.output` only.
        let (legacy_sink, legacy_seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            legacy_sink,
            Some("legacy".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let legacy = outputs(&legacy_seen);
        assert!(
            !legacy.is_empty(),
            "legacy attach replays terminal.output frames"
        );
        assert!(
            batches(&legacy_seen).is_empty(),
            "legacy attach must NOT emit batch frames"
        );
        let legacy_data: String = {
            let mut v: Vec<_> = legacy
                .iter()
                .map(|f| (f.seq_start, f.data.clone()))
                .collect();
            v.sort_by_key(|(s, _)| *s);
            v.into_iter().map(|(_, d)| d).collect()
        };

        // (b) batch subscriber (capability + attachRequestId) — must get
        // `terminal.output.batch`, reassembling to the SAME bytes, with UTF-16
        // endOffsets and a self-consistent serializedBytes.
        let (batch_sink, batch_seen) = collector();
        let _ = reg.attach(
            "T",
            2,
            batch_sink,
            Some("batch".into()),
            0,
            true,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let bs = batches(&batch_seen);
        assert!(
            !bs.is_empty(),
            "batch attach emits terminal.output.batch frames"
        );
        assert!(
            outputs(&batch_seen).is_empty(),
            "batch attach must NOT emit legacy terminal.output"
        );
        let batch_data: String = {
            let mut v: Vec<_> = bs.iter().map(|b| (b.seq_start, b.data.clone())).collect();
            v.sort_by_key(|(s, _)| *s);
            v.into_iter().map(|(_, d)| d).collect()
        };
        assert_eq!(
            batch_data, legacy_data,
            "batch and legacy reassemble to identical bytes"
        );
        assert_eq!(batch_data, "hello world\r\n");
        for b in &bs {
            assert_eq!(b.attach_request_id, "batch");
            assert!(matches!(b.source, freshell_protocol::OutputSource::Replay));
            assert!(b.serialized_bytes > 0, "serializedBytes fixpoint converged");
            // Segment endOffsets are UTF-16 cumulative and slice the data exactly.
            let mut prev = 0i64;
            let mut reassembled = String::new();
            for seg in &b.segments {
                reassembled.push_str(&crate::batch::slice_utf16(&b.data, prev, seg.end_offset));
                prev = seg.end_offset;
            }
            assert_eq!(
                reassembled, b.data,
                "UTF-16 endOffsets reconstruct the batch data"
            );
        }
    }

    #[test]
    fn batch_multibyte_endoffset_is_utf16_not_bytes() {
        // A batch containing an emoji must carry a UTF-16 endOffset (2 per emoji), not
        // the 4-byte UTF-8 length — the §9.3 Top-risk-#2 proof at the registry.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "a\u{1F600}b\r\n", "S")); // a😀b␍␊

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("m".into()),
            0,
            true,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let bs = batches(&seen);
        assert_eq!(bs.len(), 1);
        let b = &bs[0];
        assert_eq!(b.data, "a\u{1F600}b\r\n");
        // "a😀b␍␊" = 1+2+1+1+1 = 6 UTF-16 code units, but 8 UTF-8 bytes.
        let last = b.segments.last().unwrap();
        assert_eq!(last.end_offset, 6, "UTF-16 code units");
        assert_ne!(last.end_offset, 8, "must NOT be the byte length");
    }

    #[test]
    fn attach_replays_scrollback_in_seq_order_stamped_as_replay() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Three frames produced BEFORE any client attaches (the background scrollback).
        reg.feed("T", frame(1, "one\r\n", "S"));
        reg.feed("T", frame(2, "two\r\n", "S"));
        reg.feed("T", frame(3, "three\r\n", "S"));

        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("att-1".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(out.found);

        // attach.ready first, then the 3 replayed frames.
        let ready = attach_ready(&seen).expect("attach.ready sent");
        assert_eq!(ready.head_seq, 3);
        assert_eq!(ready.replay_from_seq, 1);
        assert_eq!(ready.replay_to_seq, 3);
        assert_eq!(
            ready.geometry_authority,
            Some(GeometryAuthority::SingleClient)
        );

        let frames = outputs(&seen);
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames.iter().map(|f| f.data.as_str()).collect::<Vec<_>>(),
            vec!["one\r\n", "two\r\n", "three\r\n"]
        );
        // Replayed frames are stamped with THIS attach's id and source:'replay'.
        for f in &frames {
            assert_eq!(f.attach_request_id.as_deref(), Some("att-1"));
            assert_eq!(f.source, Some(OutputSource::Replay));
        }
    }

    #[test]
    fn paced_attach_ready_carries_oldest_retained_seq_from_the_ring_front() {
        // Restore contract (responsive-terminal-restore): a NEGOTIATED attach
        // (pacedTerminalReplayV1) reports the earliest sequence position still
        // available for replay — the retained ring's front seqStart.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "one\r\n", "S"));
        reg.feed("T", frame(2, "two\r\n", "S"));

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("fresh".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let ready = attach_ready(&seen).expect("attach.ready sent");
        assert_eq!(ready.head_seq, 2);
        assert_eq!(
            ready.oldest_retained_seq,
            Some(1),
            "a negotiated fresh attach reports the ring front as the retention bound"
        );
    }

    #[test]
    fn paced_delta_attach_reports_ring_front_not_the_replay_slice() {
        // A delta attach (sinceSeq > 0) replays only the newer frames, but the
        // retention bound it reports is the RING's front — the earliest
        // position still available for a future re-attach, not this attach's
        // replay slice.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "one\r\n", "S"));
        reg.feed("T", frame(2, "two\r\n", "S"));
        reg.feed("T", frame(3, "three\r\n", "S"));

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("delta".into()),
            2,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let ready = attach_ready(&seen).expect("attach.ready sent");
        assert_eq!(
            ready.replay_from_seq, 3,
            "delta attach replays only frame 3"
        );
        assert_eq!(
            ready.oldest_retained_seq,
            Some(1),
            "the retention bound is the ring front even when the replay slice starts later"
        );
    }

    #[test]
    fn paced_attach_ready_on_empty_ring_reports_head_plus_one() {
        // Nothing older than the head is retained => the earliest replayable
        // position is headSeq+1 (fresh headless terminal: head 0 => 1).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("empty".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let ready = attach_ready(&seen).expect("attach.ready sent");
        assert_eq!(ready.head_seq, 0);
        assert_eq!(
            ready.oldest_retained_seq,
            Some(1),
            "an empty ring retains nothing older than the head: the bound is headSeq+1"
        );
    }

    #[test]
    fn replay_bounds_reports_head_and_ring_front_without_payloads() {
        // The writer-facing accessor: current head plus the earliest
        // still-replayable position, in one brief per-terminal lock pass.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "one\r\n", "S"));
        reg.feed("T", frame(2, "two\r\n", "S"));
        reg.feed("T", frame(3, "three\r\n", "S"));
        assert_eq!(
            reg.replay_bounds("T"),
            Some(ReplayBounds {
                head_seq: 3,
                oldest_retained_seq: 1,
            })
        );
    }

    #[test]
    fn replay_bounds_on_empty_ring_reports_head_plus_one() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        assert_eq!(
            reg.replay_bounds("T"),
            Some(ReplayBounds {
                head_seq: 0,
                oldest_retained_seq: 1,
            })
        );
    }

    #[test]
    fn replay_bounds_for_unknown_terminal_is_none() {
        let reg = TerminalRegistry::new();
        assert_eq!(reg.replay_bounds("nope"), None);
    }

    // ── Paced replay core (responsive-terminal-restore, Workstream 1) ────────
    //
    // The registry's page-read primitives + the attach-time session start.
    // The ws pacing coordinator (credit gating, tail drain, events) drives
    // these; its behavior is pinned by the `freshell-ws` integration suite.

    /// Flatten one page's wire messages into `(seq, data)` pairs (legacy
    /// per-frame and batch pages both reassemble to these).
    fn page_seq_data(messages: &[ServerMessage]) -> Vec<(i64, String)> {
        let mut out = Vec::new();
        for msg in messages {
            match msg {
                ServerMessage::TerminalOutput(o) => out.push((o.seq_start, o.data.clone())),
                ServerMessage::TerminalOutputBatch(b) => {
                    // A merged batch is one seq span over its concatenated data.
                    let mut prev = 0i64;
                    for seg in &b.segments {
                        let chunk = crate::batch::slice_utf16(&b.data, prev, seg.end_offset);
                        out.push((seg.seq_start, chunk));
                        prev = seg.end_offset;
                    }
                }
                other => panic!("unexpected page message: {other:?}"),
            }
        }
        out
    }

    fn page_serialized_bytes(messages: &[ServerMessage]) -> usize {
        messages
            .iter()
            .map(|m| serde_json::to_string(m).expect("page serializes").len())
            .sum()
    }

    /// The subscriber-side view of one paced attach: sink messages seen so
    /// far (should be ONLY the control prelude — ready/sync/gap) plus the
    /// returned first page and session description.
    #[test]
    fn paced_attach_returns_the_first_page_instead_of_an_inline_replay() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(1024);
        reg.insert_headless("T", "S");
        for seq in 1..=8 {
            reg.feed("T", frame(seq, &format!("data-{seq:03}\r\n"), "S"));
        }

        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced-1".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(out.found);
        let start = out.paced.expect("negotiated attach starts a paced session");
        assert_eq!(start.session.terminal_id, "T");
        assert_eq!(start.session.stream_id, "S");
        assert_eq!(start.session.attach_request_id, "paced-1");
        assert_eq!(start.session.target, 8, "target is the head at attach time");
        assert_eq!(start.session.effective_since, 0);

        // The inline sink saw ONLY the control prelude — the replay frames
        // travel as returned pages, never sunk under the attach lock.
        for msg in seen.lock().unwrap().iter() {
            assert!(
                !matches!(msg, ServerMessage::TerminalOutput(_)),
                "no replay output may be sunk inline: {msg:?}"
            );
        }

        // The first page is a bounded ascending prefix of the replay window.
        assert!(!start.first_page.is_empty(), "there is replay to page");
        assert!(page_serialized_bytes(&start.first_page) <= 1024);
        let page1 = page_seq_data(&start.first_page);
        assert_eq!(
            page1.first().unwrap().0,
            1,
            "the page starts at the baseline+1"
        );
        let last_seq = page1.last().unwrap().0;
        assert_eq!(
            start.session.page_end, last_seq,
            "the session cursor is the first page's last seq"
        );
        assert!(
            last_seq < 8,
            "the first page is a bounded prefix, not the whole window"
        );
        assert_eq!(
            start.session.page_bytes,
            page_serialized_bytes(&start.first_page) as u64
        );
        for msg in &start.first_page {
            match msg {
                ServerMessage::TerminalOutput(o) => {
                    assert_eq!(o.attach_request_id.as_deref(), Some("paced-1"));
                    assert_eq!(
                        o.source,
                        Some(OutputSource::Replay),
                        "replay pages are stamped source:'replay'"
                    );
                }
                other => panic!("unexpected first-page message: {other:?}"),
            }
        }
    }

    /// Round-2 finding F3: the negotiated `replayPageBytes` request is an
    /// optional UPPER BOUND the server honors on the WHOLE session —
    /// `min(requested, registry cap)` when present and positive, the
    /// registry cap when absent or invalid — and the recorded session
    /// budget is what credits and the tail drain page at later.
    #[test]
    fn paced_attach_honors_a_smaller_requested_page_budget() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(4096);
        reg.insert_headless("T", "S");
        for seq in 1..=12 {
            reg.feed("T", frame(seq, &format!("line-{seq:03}\r\n"), "S"));
        }
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced-budget".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions {
                replay_page_bytes: Some(600),
                ..PacedAttachOptions::default()
            },
        );
        let start = out.paced.expect("paced session");
        assert_eq!(
            start.session.page_budget, 600,
            "the requested bound clamps to itself when under the cap"
        );
        assert!(
            page_serialized_bytes(&start.first_page) <= 600,
            "the first page is sized to the request, not the cap"
        );
        assert!(
            start.first_page.len() < 12,
            "a 600-byte bound pages the window instead of packing it whole"
        );
        // The SAME bound pages the rest of the credited window: a
        // registry-cap read would pack far more per page.
        let mut cursor = start.session.page_end;
        let mut pages = 1;
        while cursor < start.session.target {
            match reg.next_replay_page("T", 1, cursor, start.session.target, 600) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    assert!(
                        page_serialized_bytes(&messages) <= 600,
                        "every credited page honors the requested bound"
                    );
                    assert!(end_seq > cursor);
                    cursor = end_seq;
                    pages += 1;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }
        assert!(pages > 2, "the smaller bound means more pages: {pages}");
    }

    #[test]
    fn paced_attach_page_budget_clamps_at_the_server_cap() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(4096);
        reg.insert_headless("T", "S");
        for seq in 1..=4 {
            reg.feed("T", frame(seq, &format!("line-{seq}\r\n"), "S"));
        }
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced-cap-clamp".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions {
                replay_page_bytes: Some(16 * 1024 * 1024),
                ..PacedAttachOptions::default()
            },
        );
        let start = out.paced.expect("paced session");
        assert_eq!(
            start.session.page_budget, 4096,
            "an oversized request clamps to the server's own cap"
        );
    }

    #[test]
    fn paced_attach_page_budget_absent_or_invalid_keeps_the_server_default() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(4096);
        reg.insert_headless("T", "S");
        for seq in 1..=4 {
            reg.feed("T", frame(seq, &format!("line-{seq}\r\n"), "S"));
        }
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced-default".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert_eq!(
            out.paced.expect("paced session").session.page_budget,
            4096,
            "an absent request keeps the server default"
        );

        // A non-positive request is invalid, not a bound: the registry
        // double-checks positivity (the protocol layer's lossy
        // deserializer already filters it on the wire, but the registry
        // is also a direct embedder API).
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced-invalid".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions {
                replay_page_bytes: Some(0),
                ..PacedAttachOptions::default()
            },
        );
        assert_eq!(
            out.paced.expect("paced session").session.page_budget,
            4096,
            "an invalid request keeps the server default"
        );
    }

    /// E2R1 finding 2: a request below the frame cap can still receive an
    /// ATOMIC single-frame page — the page builder always includes the
    /// window's first frame even when it alone exceeds the requested
    /// budget (a single frame larger than the request forms its own page)
    /// — and that page is bounded by the DOCUMENTED ceiling: the fragment
    /// cap plus the page-envelope slack, never unbounded. Pinned in BOTH
    /// wire forms (the plain per-frame arm and the batch arm), because
    /// the drain-admission reservation accounts exactly this ceiling for
    /// sub-cap budgets.
    #[test]
    fn the_atomic_single_frame_page_stays_within_the_documented_ceiling() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(4096);
        reg.insert_headless("T", "S");
        // One maximal frame (the worst case production can stage: every
        // PTY byte is ingested through the fragment splitter, so a
        // frame's serialized payload never exceeds the fragment cap) plus
        // a small successor, so the window provably has more to page
        // after the atomic result.
        let cap = crate::fragment::terminal_stream_batch_max_bytes();
        let mut len = cap;
        while crate::fragment::measure_terminal_output_budget_payload_bytes(
            "T",
            "S",
            &"A".repeat(len),
        ) > cap
        {
            len -= 1;
        }
        reg.feed("T", frame(1, &"A".repeat(len), "S"));
        reg.feed("T", frame(2, "after\r\n", "S"));
        let ceiling = crate::fragment::paced_atomic_page_serialized_ceiling();

        for (arid, batch_mode) in [("paced-atomic-plain", false), ("paced-atomic-batch", true)] {
            let (sink, _seen) = collector();
            let out = reg.attach(
                "T",
                1,
                sink,
                Some(arid.into()),
                0,
                batch_mode,
                true,
                None,
                None,
                None,
                PacedAttachOptions {
                    replay_page_bytes: Some(2048),
                    ..PacedAttachOptions::default()
                },
            );
            let start = out.paced.expect("paced session");
            assert_eq!(
                start.session.page_budget, 2048,
                "the sub-cap request is the session's budget ({arid})"
            );
            assert_eq!(
                start.first_page.len(),
                1,
                "a frame larger than the request forms its own atomic single-frame page ({arid})"
            );
            let page_bytes = page_serialized_bytes(&start.first_page);
            assert!(
                page_bytes > 2048,
                "the atomic exception is REAL: the page provably exceeds the request ({arid}, {page_bytes}B)"
            );
            assert!(
                page_bytes <= ceiling,
                "the atomic page reaches only the documented ceiling ({arid}: {page_bytes}B > {ceiling}B)"
            );
            assert!(
                start.session.page_end < start.session.target,
                "the atomic page leaves the window's remainder for later pages ({arid})"
            );
        }
    }

    /// Round-2 finding F1 (Major): a natural exit while a paced
    /// subscriber's deferral is armed must NOT sink terminal.exit ahead
    /// of the still-deferred final output — the exit is STAGED on the
    /// subscriber, the connection is notified (so its credited-phase
    /// session can move to the exit-drain), and the completing verdict
    /// delivers the staged exit in the SAME lock hold, ordered after the
    /// final pages (plan:190 sequenced exit delivery).
    #[test]
    fn natural_exit_stages_the_paced_exit_until_the_drain_delivers_the_final_output() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(0); // per-frame pages: deterministic cursor control
        reg.insert_headless("T", "S");
        for seq in 1..=3 {
            reg.feed("T", frame(seq, "before-attach\r\n", "S"));
        }
        let (sink, seen) = collector();
        let notifies: Arc<StdMutex<Vec<(String, i64)>>> = Arc::new(StdMutex::new(Vec::new()));
        let notify_sink = Arc::clone(&notifies);
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced-exit".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions {
                paced_exit_notify: Some(Arc::new(move |terminal_id, exit_code| {
                    notify_sink
                        .lock()
                        .unwrap()
                        .push((terminal_id.to_string(), exit_code));
                })),
                ..PacedAttachOptions::default()
            },
        );
        let start = out.paced.expect("paced session");
        assert_eq!(start.session.page_end, 1, "budget 0 => one frame per page");

        // The terminal produces its FINAL output past the attach target
        // and then exits naturally — the exit hook fires AFTER the last
        // ingest (pty.rs runs the hook after the reader's final flush).
        for seq in 4..=6 {
            reg.feed("T", frame(seq, "FINAL-OUTPUT\r\n", "S"));
        }
        assert!(reg.finish_pty_exit("T", 0), "the first exit finishes");

        // THE STAGING: no terminal.exit yet — the deferred range (2..=6)
        // is undelivered, and exit-first would strand it (the client's
        // exit handler clears the attach and rejects late frames).
        assert!(
            !seen
                .lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalExit(_))),
            "terminal.exit must NOT precede the deferred final output"
        );
        // The connection was notified so its session can move to the
        // exit-drain.
        assert_eq!(
            notifies.lock().unwrap().as_slice(),
            &[("T".to_string(), 0)],
            "the staged exit notifies the owning connection"
        );
        // The subscriber survives the exit (the drain needs it); a
        // LEGACY subscriber on another connection would have been retired
        // immediately.
        assert_eq!(
            reg.paced_exit_pending_of("T", 1),
            Some(0),
            "the exit is staged on the paced subscriber"
        );

        // The exit-drain (the ws drain task calls complete_paced_tail with
        // the head-at-exit target): every deferred page, then the staged
        // exit LAST, and the subscriber retires with the exit.
        let mut cursor = start.session.page_end;
        loop {
            match reg.complete_paced_tail("T", 1, "paced-exit", cursor, 6, 0) {
                PacedTailCompletion::Handoff { end_seq, .. } => {
                    assert!(end_seq > cursor, "the exit-drain pages forward");
                    cursor = end_seq;
                }
                PacedTailCompletion::Completed { end_seq, .. } => {
                    assert!(end_seq >= 6, "the deferred range is fully delivered");
                    break;
                }
                other => panic!("unexpected verdict: {other:?}"),
            }
        }
        let delivered: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some(o.data.clone()),
                ServerMessage::TerminalExit(_) => Some("<exit>".to_string()),
                _ => None,
            })
            .collect();
        let exit_at = delivered
            .iter()
            .position(|d| d == "<exit>")
            .expect("the staged exit is delivered at completion");
        assert_eq!(
            delivered.len(),
            exit_at + 1,
            "terminal.exit is the LAST frame the client observes: {delivered:?}"
        );
        assert!(
            delivered
                .iter()
                .take(exit_at)
                .any(|d| d.contains("FINAL-OUTPUT")),
            "the deferred final output arrives before the exit: {delivered:?}"
        );
        assert_eq!(
            reg.paced_exit_pending_of("T", 1),
            None,
            "the subscriber retired with the delivered exit"
        );
    }

    /// E2R1 finding 1: [`TerminalRegistry::staged_paced_exit`] is the
    /// AUTHORITY the ws layer's exit-sequencing decisions query (the
    /// staging happens under the terminal lock, before the connection's
    /// notify hook fires — so a query anywhere after that point observes
    /// it regardless of the notify's dispatch order). Pin its
    /// truthfulness: None before any exit, None for unknown terminals
    /// and connections, Some(code) once a deferred subscriber's terminal
    /// exits naturally.
    #[test]
    fn staged_paced_exit_reports_the_authority_the_ws_layer_sequences_on() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(0);
        reg.insert_headless("T", "S");
        for seq in 1..=3 {
            reg.feed("T", frame(seq, "history\r\n", "S"));
        }
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced-authority".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let _ = out.paced.expect("paced session");
        assert_eq!(
            reg.staged_paced_exit("T", 1),
            None,
            "no exit is staged while the terminal lives"
        );
        assert_eq!(
            reg.staged_paced_exit("T", 2),
            None,
            "an unknown connection has nothing staged"
        );
        assert_eq!(
            reg.staged_paced_exit("T-gone", 1),
            None,
            "an unknown terminal is None, not a panic"
        );
        assert!(reg.finish_pty_exit("T", 7), "the first exit finishes");
        assert_eq!(
            reg.staged_paced_exit("T", 1),
            Some(7),
            "the staged exit code is the ws layer's sequencing authority"
        );
    }

    /// E2R3 (the atomic exit-transition decision) test-support seam: the
    /// one-shot staging hook fires INSIDE a staged-exit read's
    /// terminal-lock hold, immediately AFTER the read — the read itself
    /// returns the PRE-staging state (the deterministic model of the PTY
    /// reader staging its exit concurrently with the decision's use of
    /// that read), the staging is durable, and the hook never fires
    /// twice.
    #[test]
    fn paced_exit_stage_hook_stages_inside_the_reads_lock_scope_once() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        for seq in 1..=2 {
            reg.feed("T", frame(seq, "history\r\n", "S"));
        }
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("hook-site".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let _ = out.paced.expect("paced session");

        reg.set_paced_exit_stage_hook_for_tests(1, 9);
        assert_eq!(
            reg.staged_paced_exit("T", 1),
            None,
            "the firing read observes the PRE-staging state — the hook stages after it"
        );
        assert_eq!(
            reg.staged_paced_exit("T", 1),
            Some(9),
            "the hook's staging landed inside the firing read's lock scope (durable)"
        );
        assert_eq!(
            reg.staged_paced_exit("T", 1),
            Some(9),
            "the hook is one-shot: later reads never restage"
        );
        // The staging mirrors finish_pty_exit's subscriber-relevant
        // subset: the terminal is naturally Exited (monotone — a later
        // real exit is inert) and the DEFERRED subscriber holds the code.
        assert!(
            reg.terminal_is_dead("T"),
            "the staged exit marks the terminal dead"
        );
        assert!(
            !reg.finish_pty_exit("T", 77),
            "the later real exit is inert (monotone, once-only)"
        );
        assert_eq!(reg.paced_exit_pending_of("T", 1), Some(9));
    }

    /// E2R3 test-support: the public test staging mirrors
    /// `finish_pty_exit`'s subscriber-relevant subset — it stages ONLY
    /// on a DEFERRED (paced) subscriber, refuses unknown terminals and
    /// connections without mutating anything, and is monotone.
    #[test]
    fn stage_natural_exit_for_test_stages_only_deferred_subscribers_monotonically() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        // A LEGACY subscriber never stages (finish_pty_exit retires it
        // instead); an unknown connection or terminal never stages.
        let _ = reg.attach(
            "T",
            7,
            sink,
            Some("legacy".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(
            !reg.stage_natural_exit_for_test("T", 7, 4),
            "a non-deferred subscriber never stages"
        );
        assert!(
            !reg.stage_natural_exit_for_test("T", 8, 4),
            "an unknown connection never stages"
        );
        assert!(
            !reg.stage_natural_exit_for_test("T-gone", 7, 4),
            "an unknown terminal is false, not a panic"
        );

        let (paced_sink, _paced_seen) = collector();
        let out = reg.attach(
            "T",
            1,
            paced_sink,
            Some("paced-stage".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let _ = out.paced.expect("paced session");
        assert!(reg.stage_natural_exit_for_test("T", 1, 4));
        assert_eq!(
            reg.paced_exit_pending_of("T", 1),
            Some(4),
            "the deferred subscriber holds the staged code"
        );
        assert!(
            !reg.stage_natural_exit_for_test("T", 1, 5),
            "the staging is monotone (once-only)"
        );
        assert_eq!(
            reg.paced_exit_pending_of("T", 1),
            Some(4),
            "the refused restage changed nothing"
        );
    }

    /// E2R3 (the atomic exit-transition decision): the decision reads
    /// the staged exit and the terminal's FROZEN head together under
    /// ONE lock hold — `None` before any exit (atomically confirmed),
    /// the frozen final head once staged, `None` for unknown terminals
    /// and connections.
    #[test]
    fn paced_exit_transition_reads_the_staging_and_frozen_head_together() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        for seq in 1..=2 {
            reg.feed("T", frame(seq, "history\r\n", "S"));
        }
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("transition".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let _ = out.paced.expect("paced session");

        assert_eq!(
            reg.paced_exit_transition("T", 1),
            PacedExitTransition { exit_head: None },
            "no exit staged: None, atomically confirmed under the decision's hold"
        );
        assert_eq!(
            reg.paced_exit_transition("T", 2),
            PacedExitTransition { exit_head: None },
            "an unknown connection decides None"
        );
        assert_eq!(
            reg.paced_exit_transition("T-gone", 1),
            PacedExitTransition { exit_head: None },
            "an unknown terminal decides None, not a panic"
        );

        // The exit stages with final output past the prior head; the
        // decision carries the terminal's FROZEN final head (not the
        // exit code) so the caller can extend the credited phase
        // through it.
        for seq in 3..=4 {
            reg.feed("T", frame(seq, "FINAL\r\n", "S"));
        }
        assert!(reg.finish_pty_exit("T", 5));
        assert_eq!(
            reg.paced_exit_transition("T", 1),
            PacedExitTransition { exit_head: Some(4) },
            "the decision carries the terminal's frozen final head"
        );
    }

    /// E2R3 test-support: the one-shot hook fires at the DECISION site
    /// AFTER its read — the decision itself returns the pre-staging
    /// state (the deterministic model of the PTY reader staging
    /// concurrently with THIS decision's use of its read), and the
    /// NEXT decision — with no further staging — reads the staged exit
    /// under its own single hold. This is the interleave the ws
    /// transition-race tests ride end-to-end.
    #[test]
    fn paced_exit_transition_hook_stages_after_the_decisions_read() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        for seq in 1..=2 {
            reg.feed("T", frame(seq, "history\r\n", "S"));
        }
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("decision-hook".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let _ = out.paced.expect("paced session");

        reg.set_paced_exit_stage_hook_for_tests(1, 6);
        assert_eq!(
            reg.paced_exit_transition("T", 1),
            PacedExitTransition { exit_head: None },
            "the firing decision observes the PRE-staging state — the hook stages after its read"
        );
        assert_eq!(
            reg.paced_exit_transition("T", 1),
            PacedExitTransition { exit_head: Some(2) },
            "the hook's staging landed inside the firing decision's lock scope; \
             the next decision reads the frozen head under its own hold"
        );
    }

    /// Round-2 finding F1, the unchanged neighbors: a NON-paced subscriber
    /// still receives terminal.exit immediately at the natural exit, and a
    /// paced attach to an ALREADY-EXITED terminal keeps the frozen legacy
    /// inline replay + synthesized exit (no session, no staging).
    #[test]
    fn natural_exit_delivers_immediately_to_non_paced_subscribers_and_exited_terminals_stay_legacy()
    {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        for seq in 1..=2 {
            reg.feed("T", frame(seq, "history\r\n", "S"));
        }
        // A LEGACY subscriber: exit delivery is immediate and final.
        let (legacy_sink, legacy_seen) = collector();
        let _ = reg.attach(
            "T",
            7,
            legacy_sink,
            Some("legacy".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(reg.finish_pty_exit("T", 3));
        assert!(
            legacy_seen
                .lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalExit(e) if e.exit_code == 3)),
            "the legacy subscriber gets terminal.exit immediately"
        );
        assert!(
            reg.paced_exit_pending_of("T", 7).is_none(),
            "the legacy subscriber retired with its exit"
        );

        // A NEGOTIATED attach to the already-Exited terminal: the legacy
        // inline replay + synthesized exit, exactly the frozen shape — no
        // paced session, no staging (the attach-after-exit case is
        // unchanged by the exit-sequencing fix).
        let (paced_sink, paced_seen) = collector();
        let out = reg.attach(
            "T",
            8,
            paced_sink,
            Some("after-exit".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(
            out.paced.is_none(),
            "an already-exited terminal never starts a paced session"
        );
        let seen = paced_seen.lock().unwrap();
        let exit_at = seen
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalExit(_)))
            .expect("the synthesized exit arrives with the legacy attach");
        assert!(
            seen.iter().take(exit_at).any(|m| matches!(
                m,
                ServerMessage::TerminalOutput(o) if o.seq_start == 1
            )),
            "the frozen inline replay precedes the synthesized exit"
        );
    }

    /// A batch-capable negotiated subscriber gets `terminal.output.batch`
    /// pages that reassemble to the same bytes as the per-frame projection.
    #[test]
    fn paced_batch_pages_reassemble_to_the_frame_bytes() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(4096);
        reg.insert_headless("T", "S");
        for seq in 1..=5 {
            reg.feed("T", frame(seq, &format!("line-{seq}\r\n"), "S"));
        }
        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            2,
            sink,
            Some("batch-paced".into()),
            0,
            true,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");
        assert!(
            start
                .first_page
                .iter()
                .all(|m| matches!(m, ServerMessage::TerminalOutputBatch(_))),
            "a batch-capable subscriber gets batch pages"
        );
        // Drive any remaining pages (the first page may be a bounded prefix)
        // and reassemble EVERYTHING the session delivers.
        let mut page_messages = start.first_page.clone();
        let mut cursor = start.session.page_end;
        while cursor < start.session.target {
            match reg.next_replay_page("T", 2, cursor, start.session.target, 4096) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    page_messages.extend(messages);
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }
        let reassembled: String = {
            let mut v: Vec<(i64, String)> = page_seq_data(&page_messages);
            v.sort_by_key(|(s, _)| *s);
            v.into_iter().map(|(_, d)| d).collect()
        };
        assert_eq!(
            reassembled,
            (1..=5).map(|i| format!("line-{i}\r\n")).collect::<String>()
        );
    }

    /// Page-budget honesty at the boundary: the batch-mode charge must
    /// cover the one-frame batch ENVELOPE delta — the `.batch` type suffix,
    /// the `serializedBytes` field, and the `segments[]` wrapper, which the
    /// legacy-scaffold + segment estimate alone never accounted. Two
    /// BARRIER frames (BEL ⇒ `turn_complete`) each form their own
    /// single-frame batch, so a page carrying both pays TWO batch
    /// envelopes; the budget is tuned so the pre-delta accounting admits
    /// both frames while their real wire bytes exceed it. With the delta
    /// charged, the walk emits each frame as its own single-frame page —
    /// every page the walk believes fits the budget really fits.
    #[test]
    fn paced_batch_page_accounting_covers_the_envelope_at_the_budget_boundary() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let data_a = format!("{}{}", "a".repeat(120), '\u{0007}');
        let data_b = format!("{}{}", "b".repeat(120), '\u{0007}');
        reg.feed("T", frame(1, &data_a, "S"));
        reg.feed("T", frame(2, &data_b, "S"));

        // Size the budget from the crate's own envelope accounting: the
        // pre-delta per-frame charge (scaffold + seq digits + escaped data +
        // the segment estimate) for BOTH frames plus a 5-byte margin — the
        // exact boundary corner where an un-accounted envelope delta can
        // push a page's real serialized bytes over the budget.
        let scaffold = crate::batch::legacy_envelope_scaffold_bytes(
            "T",
            "S",
            Some("batch-paced"),
            Some("replay"),
        ) as i64;
        let accounted_pre_delta = |data: &str| {
            scaffold
                + crate::batch::digit_count(1) as i64
                + crate::batch::digit_count(2) as i64
                + crate::batch::json_escaped_len(data) as i64
                + SEGMENT_WIRE_OVERHEAD_ESTIMATE
        };
        let budget = accounted_pre_delta(&data_a) + accounted_pre_delta(&data_b) + 5;
        reg.set_paced_page_max_bytes(budget);

        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            2,
            sink,
            Some("batch-paced".into()),
            0,
            true,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");

        // The first page honors the budget with REAL serialized bytes.
        assert!(
            start.session.page_bytes as i64 <= budget,
            "the first page's real serialized bytes ({}) must stay within the \
             budget ({budget}) — the batch envelope delta must be accounted",
            start.session.page_bytes
        );
        assert_eq!(
            page_serialized_bytes(&start.first_page) as i64,
            start.session.page_bytes as i64,
            "the session's page_bytes is the page's real serialized size"
        );
        // The envelope corner is real for this fixture: one single-frame
        // batch page's wire cost exceeds the pre-delta accounted charge.
        assert!(
            page_serialized_bytes(&start.first_page) as i64 > accounted_pre_delta(&data_a),
            "the fixture must actually exercise the envelope delta corner"
        );
        // The walk stopped before frame 2: the first page is a single
        // frame's own single-frame batch page.
        let page1 = page_seq_data(&start.first_page);
        assert_eq!(
            page1.iter().map(|(s, _)| *s).collect::<Vec<_>>(),
            vec![1],
            "the delta-inclusive charge leaves frame 2 for its own page"
        );
        assert!(
            start.first_page.len() == 1,
            "one single-frame batch payload"
        );
        assert!(matches!(
            start.first_page[0],
            ServerMessage::TerminalOutputBatch(_)
        ));

        // Frame 2 arrives as its own bounded single-frame page.
        match reg.next_replay_page("T", 2, start.session.page_end, start.session.target, budget) {
            PacedPage::Frames {
                messages,
                end_seq,
                serialized_bytes,
            } => {
                assert_eq!(end_seq, 2);
                assert_eq!(messages.len(), 1, "one single-frame batch payload");
                assert!(
                    serialized_bytes as i64 <= budget,
                    "every page the walk emits within its accounting stays \
                     within the budget: {serialized_bytes} > {budget}"
                );
                assert!(
                    serialized_bytes as i64 > accounted_pre_delta(&data_b),
                    "frame 2's real page cost also exceeds the pre-delta charge"
                );
            }
            other => panic!("expected frame 2's page, got {other:?}"),
        }
        match reg.next_replay_page("T", 2, 2, start.session.target, budget) {
            PacedPage::Done => {}
            other => panic!("a drained window reads Done, got {other:?}"),
        }
    }

    /// Pages ascend within the serialized budget to the FIXED attach-time
    /// target — output produced after the attach never extends the replay
    /// range (it is tail-phase delivery instead).
    #[test]
    fn paced_replay_pages_stop_at_the_fixed_target_within_the_budget() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(1024);
        reg.insert_headless("T", "S");
        for seq in 1..=8 {
            reg.feed("T", frame(seq, &format!("data-{seq:03}\r\n"), "S"));
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");
        let mut cursor = start.session.page_end;
        let mut collected = page_seq_data(&start.first_page);

        // Concurrent output AFTER the attach must NOT extend the target.
        for seq in 9..=12 {
            reg.feed("T", frame(seq, &format!("post-{seq:03}\r\n"), "S"));
        }

        while cursor < 8 {
            match reg.next_replay_page("T", 1, cursor, 8, 1024) {
                PacedPage::Frames {
                    messages,
                    end_seq,
                    serialized_bytes,
                } => {
                    assert!(
                        serialized_bytes as usize <= 1024,
                        "every replay page honors the serialized budget"
                    );
                    assert!(end_seq > cursor, "pages must make progress");
                    assert!(end_seq <= 8, "pages never pass the fixed target");
                    collected.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                PacedPage::Done => panic!("Done while cursor {cursor} < target 8"),
                PacedPage::Expired { .. } => panic!("no retention loss in this fixture"),
                PacedPage::Gone => panic!("terminal vanished mid-replay"),
            }
        }
        assert_eq!(cursor, 8);
        match reg.next_replay_page("T", 1, cursor, 8, 1024) {
            PacedPage::Done => {}
            other => panic!("a drained replay window reads Done, got {other:?}"),
        }
        let replayed: String = {
            let mut v = collected.clone();
            v.sort_by_key(|(s, _)| *s);
            v.into_iter().map(|(_, d)| d).collect()
        };
        assert_eq!(
            replayed,
            (1..=8)
                .map(|i| format!("data-{i:03}\r\n"))
                .collect::<String>(),
            "the replay pages cover the window exactly, in order, no loss/dup"
        );

        // The post-attach frames are TAIL delivery: the drain pages from
        // the target toward the FIXED drain target (the head at drain
        // start — the terminal is quiet here, so the pages cover exactly
        // the post-attach range), then the deferral clears at the
        // completing verdict.
        let drain_target = reg.replay_bounds("T").expect("bounds").head_seq;
        assert_eq!(drain_target, 12);
        let mut tail_cursor = cursor;
        let mut rounds = 0;
        let mut handing_off = false;
        loop {
            rounds += 1;
            assert!(rounds <= 32, "the quiet drain terminates in bounded rounds");
            let verdict = if handing_off {
                reg.handoff_paced_tail("T", 1, "paced", tail_cursor, 1024)
            } else {
                reg.complete_paced_tail("T", 1, "paced", tail_cursor, drain_target, 1024)
            };
            match verdict {
                PacedTailCompletion::Handoff {
                    end_seq,
                    serialized_bytes,
                } => {
                    assert!(serialized_bytes as usize <= 1024);
                    assert!(end_seq > tail_cursor, "pages must make progress");
                    if !handing_off {
                        assert!(end_seq <= drain_target, "pages never pass the fixed target");
                    }
                    tail_cursor = end_seq;
                }
                PacedTailCompletion::TargetCovered { end_seq, .. } => {
                    // Fixed target covered with a staged remainder beyond:
                    // the bounded post-target handoff owns it.
                    tail_cursor = end_seq;
                    handing_off = true;
                }
                PacedTailCompletion::CaughtUp => break,
                PacedTailCompletion::Completed { end_seq, .. } => {
                    tail_cursor = tail_cursor.max(end_seq);
                    break;
                }
                other => panic!("a quiet terminal completes its drain, got {other:?}"),
            }
        }
        assert_eq!(tail_cursor, 12, "the tail drains to the current head");
        let tail: String = {
            let mut v: Vec<(i64, String)> = seen
                .lock()
                .unwrap()
                .iter()
                .filter_map(|m| match m {
                    ServerMessage::TerminalOutput(o) if (9..=12).contains(&o.seq_start) => {
                        Some((o.seq_start, o.data.clone()))
                    }
                    _ => None,
                })
                .collect();
            v.sort_by_key(|(s, _)| *s);
            v.into_iter().map(|(_, d)| d).collect()
        };
        assert_eq!(
            tail,
            (9..=12)
                .map(|i| format!("post-{i:03}\r\n"))
                .collect::<String>(),
            "the tail delivers exactly the post-attach range"
        );
    }

    /// The tail drain must COMPLETE against a continuously-producing
    /// terminal within a bounded number of pages (plan W1: "Keep a fixed
    /// initial catch-up target so ongoing live output cannot move the
    /// completion condition indefinitely"; "Input and other panes'
    /// traffic remain schedulable"). This fixture interleaves one new
    /// frame with every tail page read — the deterministic model of a
    /// producer outrunning the drain — so a drain that re-reads the
    /// terminal's CURRENT head per page chases the moving head forever.
    /// The fixed-target drain completes: pages up to the tail-start head,
    /// then the one-shot handoff delivers whatever the producer staged
    /// during the drain and clears the deferral atomically.
    #[test]
    fn paced_tail_drain_completes_in_bounded_pages_against_a_live_producer() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(1024);
        reg.insert_headless("T", "S");
        for seq in 1..=8 {
            reg.feed("T", frame(seq, &format!("data-{seq:03}\r\n"), "S"));
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink.clone(),
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");

        // Drive the replay to the fixed attach-time target (8).
        let mut cursor = start.session.page_end;
        let mut delivered = page_seq_data(&start.first_page);
        while cursor < 8 {
            match reg.next_replay_page("T", 1, cursor, 8, 1024) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    delivered.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                PacedPage::Done => panic!("Done while cursor {cursor} < target 8"),
                PacedPage::Expired { .. } => panic!("no retention loss in this fixture"),
                PacedPage::Gone => panic!("terminal vanished mid-replay"),
            }
        }

        // A staged burst forms the tail, then the FIXED drain target is
        // captured ONCE (exactly what the ws drain task does at drain
        // start). It is NEVER reassigned below.
        for seq in 9..=20 {
            reg.feed("T", frame(seq, &format!("post-{seq:03}\r\n"), "S"));
        }
        let drain_target = reg.replay_bounds("T").expect("bounds").head_seq;
        assert_eq!(
            drain_target, 20,
            "the drain target is the head at drain start"
        );

        // The live producer: one new frame lands between EVERY page/chunk
        // read. A drain chasing the current head can never catch up; the
        // fixed-target drain must complete in bounded pages regardless —
        // once the target is covered, the bounded post-target handoff
        // delivers whatever the producer staged after the fixed target
        // (one page budget per lock hold) and clears atomically when a
        // chunk covers the current head.
        let mut produced = 20usize;
        let mut pages = 0usize;
        let mut handing_off = false;
        loop {
            produced += 1;
            reg.feed(
                "T",
                frame(produced as i64, &format!("live-{produced:03}\r\n"), "S"),
            );
            pages += 1;
            assert!(
                pages <= 8,
                "the drain must complete in bounded pages against a \
                 live producer (still draining after {pages} pages, cursor \
                 {cursor}, drain target {drain_target}, head {produced})",
            );
            let verdict = if handing_off {
                reg.handoff_paced_tail("T", 1, "paced", cursor, 1024)
            } else {
                reg.complete_paced_tail("T", 1, "paced", cursor, drain_target, 1024)
            };
            match verdict {
                PacedTailCompletion::Handoff { end_seq, .. } => {
                    assert!(end_seq > cursor, "pages must make progress");
                    if !handing_off {
                        assert!(
                            end_seq <= drain_target,
                            "pages never pass the fixed drain target"
                        );
                    }
                    cursor = end_seq;
                }
                PacedTailCompletion::TargetCovered { end_seq, .. } => {
                    // Fixed target covered — never re-captured: the staged
                    // remainder flows through the bounded handoff.
                    cursor = end_seq;
                    handing_off = true;
                }
                PacedTailCompletion::CaughtUp => {
                    panic!("CaughtUp with a staged remainder is impossible here")
                }
                PacedTailCompletion::Completed { end_seq, .. } => {
                    // Quiet completing hold: everything staged was within
                    // the fixed boundary (this fixture's producer appends
                    // between EVERY call, so a residual past the boundary
                    // exists and the plan:146 exit below is the expected
                    // shape; this arm is the quiet-case contract).
                    cursor = cursor.max(end_seq);
                    break;
                }
                PacedTailCompletion::GapCompleted {
                    lost_from,
                    lost_to,
                    end_seq,
                    ..
                } => {
                    // THE plan:146 FIXED-BOUNDARY EXIT (round-4): the
                    // session completed AT the fixed boundary with the
                    // frames the producer staged past it declared as the
                    // EXACT bounds-carrying delivery gap — never swept
                    // (plan:145), never chased. The delivered stream tiles
                    // (.., end_seq] and the gap declares (end_seq, produced].
                    assert_eq!(
                        lost_from,
                        end_seq + 1,
                        "the delivery gap starts just past the completing boundary"
                    );
                    assert_eq!(
                        lost_to, produced as i64,
                        "the delivery gap declares everything staged past the boundary \
                         through the producing head"
                    );
                    cursor = cursor.max(end_seq);
                    break;
                }
                PacedTailCompletion::Expired { .. } => panic!("no retention loss in this fixture"),
                PacedTailCompletion::Gone => panic!("terminal vanished mid-drain"),
            }
        }

        // Everything up to the completion boundary was delivered exactly
        // once, in order — the drain pages plus the handoff chunks tile
        // the delivered range with no hole and no duplicate; the frames
        // past the boundary are DECLARED (the delivery gap), never lost
        // silently.
        let handed_off: Vec<i64> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some(o.seq_end),
                _ => None,
            })
            .collect();
        assert_eq!(
            handed_off,
            (9..=cursor).collect::<Vec<i64>>(),
            "the drain + handoff deliver exactly the staged range, in seq order"
        );
        let mut seqs: Vec<i64> = delivered.iter().map(|(s, _)| *s).collect();
        seqs.extend(handed_off);
        seqs.sort_unstable();
        seqs.dedup();
        assert_eq!(
            seqs.last(),
            Some(&cursor),
            "the paged drain + handoff cover everything up to the completion boundary"
        );
        for expected in 1..=cursor {
            assert!(
                seqs.contains(&expected),
                "the delivered stream must be contiguous across the handoff: \
                 {expected} missing"
            );
        }
        assert_eq!(
            seqs.len(),
            cursor as usize,
            "every seq is delivered exactly once across pages + handoff"
        );

        // Post-completion output flows through DIRECT fan-out (the
        // deferral cleared at the completing hold): a new frame reaches
        // the subscriber with no page read at all.
        reg.feed("T", frame(produced as i64 + 1, "after-clear\r\n", "S"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalOutput(o)
                    if o.seq_end == produced as i64 + 1)),
            "post-clear output fans out directly to the subscriber"
        );

        // The declared delivery gap is FETCHABLE (the ring retained it):
        // the client's bounded baseline recovery — the repair attach from
        // the coverage cursor — is the fetch path (the queue_overflow
        // repair contract). Modeled here exactly as the client drives it:
        // a fresh attach from the completing boundary pages the declared
        // interval in order, so the post-boundary frames ARRIVE via the
        // normal paced page path, contiguously with the delivered prefix.
        let head_after = reg.replay_bounds("T").expect("bounds").head_seq;
        let out2 = reg.attach(
            "T",
            1,
            sink,
            Some("paced-repair".into()),
            cursor,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let repair = out2.paced.expect("the repair paced session");
        let mut repair_delivered = page_seq_data(&repair.first_page);
        let mut repair_cursor = repair.session.page_end;
        while repair_cursor < head_after {
            match reg.next_replay_page("T", 1, repair_cursor, head_after, 1024) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    repair_delivered.extend(page_seq_data(&messages));
                    repair_cursor = end_seq;
                }
                other => panic!("unexpected repair replay read: {other:?}"),
            }
        }
        let repair_seqs: Vec<i64> = repair_delivered.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            repair_seqs,
            (cursor + 1..=head_after).collect::<Vec<i64>>(),
            "the repair session pages the declared interval in order — the \
             post-boundary frames arrive via the normal paced page path"
        );
    }

    /// The tail handoff must PAGE the staged remainder through the SAME
    /// budget-bounded paging as the replay (responsive-terminal-restore:
    /// at most ONE unacknowledged page per (connection, terminal) — an
    /// `i64::MAX` full-suffix batch cloned under one lock hold defeats the
    /// page budget, blocks PTY ingestion, and monopolizes the dispatch
    /// path). A staged tail larger than one page budget must arrive as
    /// MULTIPLE handoff pages, each within the paced page budget.
    #[test]
    fn paced_tail_handoff_pages_the_staged_remainder_within_the_page_budget() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(1024);
        reg.insert_headless("T", "S");
        for seq in 1..=4 {
            reg.feed("T", frame(seq, &format!("data-{seq:03}\r\n"), "S"));
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");

        // Drive the replay to the attach-time target (4).
        let mut cursor = start.session.page_end;
        let mut delivered = page_seq_data(&start.first_page);
        while cursor < 4 {
            match reg.next_replay_page("T", 1, cursor, 4, 1024) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    delivered.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }

        // A staged tail far larger than one page budget (each frame ~120
        // serialized bytes → ~8 frames per 1024-byte page).
        for seq in 5..=40 {
            reg.feed("T", frame(seq, &format!("staged-{seq:03}\r\n"), "S"));
        }
        let completion_target = reg.replay_bounds("T").expect("bounds").head_seq;
        assert_eq!(completion_target, 40);

        // The completion drives the staged remainder through
        // budget-bounded pages: more than one handoff page for this staged
        // tail, each within the page budget, ending in EXACTLY ONE
        // completing verdict that cleared the deferral.
        let mut pages = 0usize;
        let mut completions = 0usize;
        let mut final_page_over_budget = false;
        let mut handing_off = false;
        loop {
            let verdict = if handing_off {
                reg.handoff_paced_tail("T", 1, "paced", cursor, 1024)
            } else {
                reg.complete_paced_tail("T", 1, "paced", cursor, completion_target, 1024)
            };
            match verdict {
                PacedTailCompletion::Handoff {
                    end_seq,
                    serialized_bytes,
                } => {
                    assert!(
                        serialized_bytes as usize <= 1024,
                        "each handoff page must stay within the paced page budget \
                         (got {serialized_bytes} bytes for the page ending at seq {end_seq})"
                    );
                    assert!(end_seq > cursor);
                    if !handing_off {
                        assert!(
                            end_seq <= completion_target,
                            "pages never pass the fixed drain target"
                        );
                    }
                    cursor = end_seq;
                    pages += 1;
                }
                PacedTailCompletion::TargetCovered { end_seq, .. } => {
                    // Fixed target covered with a staged remainder beyond:
                    // the bounded post-target handoff owns it.
                    cursor = end_seq;
                    handing_off = true;
                }
                PacedTailCompletion::Completed {
                    end_seq,
                    serialized_bytes,
                } => {
                    // The final page may honestly exceed the budget only as
                    // the explicit atomic oversize result (a single frame
                    // larger than the budget); this fixture's frames are
                    // tiny, so it must fit too.
                    if serialized_bytes as usize > 1024 {
                        final_page_over_budget = true;
                    }
                    assert_eq!(
                        end_seq, 40,
                        "the fixed-target boundary delivers the whole staged tail"
                    );
                    cursor = end_seq;
                    completions += 1;
                    break;
                }
                PacedTailCompletion::CaughtUp => {
                    panic!("a staged remainder exists — the handoff must deliver it")
                }
                PacedTailCompletion::Expired { .. } => panic!("no retention loss in this fixture"),
                PacedTailCompletion::GapCompleted { .. } => {
                    panic!("no mid-handoff retention loss in this fixture")
                }
                PacedTailCompletion::Gone => panic!("terminal vanished at completion"),
            }
        }
        assert!(
            pages > 1,
            "a staged tail larger than one page budget must produce multiple \
             handoff pages, got {pages}"
        );
        assert_eq!(completions, 1, "the handoff completes exactly once");
        assert!(
            !final_page_over_budget,
            "the final page fits the budget in this fixture"
        );
        assert_eq!(cursor, 40, "the handoff drained everything staged");

        // Everything staged was delivered through the sink, contiguously,
        // exactly once (the pages + handoff partition the range).
        let handed_off: Vec<i64> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some(o.seq_end),
                _ => None,
            })
            .collect();
        assert_eq!(
            handed_off,
            (5..=cursor).collect::<Vec<_>>(),
            "the handoff delivers exactly the staged remainder, in seq order"
        );
        let mut all: Vec<i64> = delivered.iter().map(|(s, _)| *s).collect();
        all.extend(handed_off);
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (1..=cursor).collect::<Vec<_>>(),
            "the delivered stream is contiguous across the handoff"
        );
    }

    /// A retention advance past the drain cursor must NEVER become a silent
    /// forward jump in the handoff (responsive-terminal-restore: retention
    /// loss mid-restore is an exact bounds-carrying gap, never a silent
    /// truncation). The completion must emit the retention gap for the
    /// omitted interval BEFORE any delivered frame, with bounds matching
    /// the actual eviction.
    #[test]
    fn paced_tail_completion_reports_retention_loss_instead_of_a_silent_forward_jump() {
        let reg = TerminalRegistry::new();
        // Tiny CHAR ring so feeding evicts the front deterministically.
        reg.set_scrollback_max_bytes(60);
        reg.insert_headless("T", "S");
        reg.set_paced_page_max_bytes(0); // per-frame pages: deterministic cursor control
        for seq in 1..=3 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S")); // 10 chars each
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");

        // Drive the replay to the attach-time target (3).
        let mut cursor = start.session.page_end;
        let mut delivered = page_seq_data(&start.first_page);
        while cursor < 3 {
            match reg.next_replay_page("T", 1, cursor, 3, 0) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    delivered.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }
        assert_eq!(cursor, 3);

        // Evict frames 4.. well past the drain cursor: 10 more chunks (100
        // chars) push the front far past seq 3.
        for seq in 4..=13 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S"));
        }
        let bounds = reg.replay_bounds("T").expect("bounds");
        assert!(
            bounds.oldest_retained_seq > 4,
            "the fixture evicted the frames the handoff needs next"
        );

        // The handoff must declare the retention loss for the omitted
        // interval with the EXACT bounds — never silently start at the
        // ring front: a forward jump from seq 3 with no gap frame is
        // silent corruption. The caller (the ws drive loop) sinks the
        // bounds-carrying gap and resumes from the ring front; the same
        // continuation is driven here.
        let head_at_expiry = bounds.head_seq;
        let gap_lo = cursor + 1;
        let seen_len_at_expiry = seen.lock().unwrap().len();
        match reg.complete_paced_tail("T", 1, "paced", cursor, head_at_expiry, 0) {
            PacedTailCompletion::Expired {
                lost_from,
                lost_to,
                resume_from,
                head_seq,
                oldest_retained_seq,
            } => {
                assert_eq!(
                    lost_from,
                    cursor + 1,
                    "the lost interval starts at cursor+1"
                );
                assert_eq!(
                    lost_to,
                    bounds.oldest_retained_seq - 1,
                    "the lost interval ends just before the new ring front"
                );
                assert_eq!(resume_from, bounds.oldest_retained_seq - 1);
                assert_eq!(head_seq, bounds.head_seq);
                assert_eq!(oldest_retained_seq, bounds.oldest_retained_seq);
                cursor = resume_from;
            }
            other => panic!(
                "a retention advance past the tail boundary must report the exact \
                 gap, never a silent forward jump, got {other:?}"
            ),
        }
        assert_eq!(
            seen.lock().unwrap().len(),
            seen_len_at_expiry,
            "the Expired verdict delivers NOTHING itself — the caller emits the gap"
        );

        // The caller's continuation: sink the exact gap (as the ws drain
        // task does), then resume the paged drain from the ring front.
        // The delivered stream is contiguous except for EXACTLY the
        // asserted gap: 1..=3 delivered, 4..=oldest-1 declared lost,
        // oldest..=head delivered in order.
        let drain_target = head_at_expiry;
        let mut handing_off = false;
        loop {
            let verdict = if handing_off {
                reg.handoff_paced_tail("T", 1, "paced", cursor, 0)
            } else {
                reg.complete_paced_tail("T", 1, "paced", cursor, drain_target, 0)
            };
            match verdict {
                PacedTailCompletion::Handoff { end_seq, .. } => {
                    if !handing_off {
                        assert!(end_seq <= drain_target, "pages never pass the fixed target");
                    }
                    cursor = end_seq;
                }
                PacedTailCompletion::TargetCovered { end_seq, .. } => {
                    // Fixed target covered with a staged remainder beyond:
                    // the bounded post-target handoff owns it (mirrors the
                    // ws drain task).
                    cursor = end_seq;
                    handing_off = true;
                }
                PacedTailCompletion::Completed { end_seq, .. } => {
                    cursor = cursor.max(end_seq);
                    break;
                }
                PacedTailCompletion::CaughtUp => break,
                PacedTailCompletion::Expired { .. } => {
                    panic!("the eviction is fully declared — no second loss expected")
                }
                PacedTailCompletion::GapCompleted { .. } => {
                    panic!("the eviction is fully declared — no mid-handoff loss expected")
                }
                PacedTailCompletion::Gone => panic!("terminal vanished mid-handoff"),
            }
        }
        assert_eq!(
            cursor, bounds.head_seq,
            "the resumed handoff drains to the head"
        );
        let handed_off: Vec<i64> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some(o.seq_end),
                _ => None,
            })
            .collect();
        assert_eq!(
            handed_off,
            (bounds.oldest_retained_seq..=bounds.head_seq).collect::<Vec<_>>(),
            "the resumed handoff delivers exactly the retained remainder, in seq order"
        );
        // Contiguity modulo exactly the asserted gap: the delivered seqs
        // plus the declared-lost interval tile 1..=head with no hole and
        // no overlap.
        let mut delivered_seqs: Vec<i64> = delivered.iter().map(|(s, _)| *s).collect();
        delivered_seqs.extend(handed_off);
        delivered_seqs.sort_unstable();
        delivered_seqs.dedup();
        let mut expected: Vec<i64> = (1..=bounds.head_seq).collect();
        expected.retain(|seq| !(gap_lo..=bounds.oldest_retained_seq - 1).contains(seq));
        assert_eq!(
            delivered_seqs, expected,
            "the delivered stream is contiguous except exactly the asserted gap"
        );

        // Post-clear output flows through DIRECT fan-out (the deferral
        // cleared at the completing verdict).
        reg.feed("T", frame(bounds.head_seq + 1, "after-clear\r\n", "S"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalOutput(o)
                    if o.seq_end == bounds.head_seq + 1)),
            "post-clear output fans out directly to the subscriber"
        );
    }

    /// The completion target is captured ONCE and never re-captured (the
    /// round-2 recapture-loophole fix): when the FIXED target is covered,
    /// the staged post-target remainder flows through the BOUNDED
    /// post-target handoff — page-budget-sized chunks per lock hold, the
    /// lock released between them (round-3 fix; never a bulk re-fan
    /// under one hold) — until a chunk covers the terminal's current
    /// head and the deferral clears atomically in that hold. Never by
    /// re-reading the terminal's current head and re-targeting the
    /// DRAIN: a drain that recaptures whenever a target is covered
    /// chases a sustained producer one "bounded" page at a time,
    /// indefinitely.
    #[test]
    fn paced_tail_completion_completes_at_the_fixed_target_never_recapturing() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(1024);
        reg.insert_headless("T", "S");
        for seq in 1..=4 {
            reg.feed("T", frame(seq, &format!("data-{seq:03}\r\n"), "S"));
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");

        // Drive the replay to the attach-time target (4).
        let mut cursor = start.session.page_end;
        let mut delivered = page_seq_data(&start.first_page);
        while cursor < 4 {
            match reg.next_replay_page("T", 1, cursor, 4, 1024) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    delivered.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }
        assert_eq!(cursor, 4);

        // A staged tail (production during the replay), and the FIXED
        // completion target captured ONCE at completion start — exactly
        // what the ws drain task does. It is NEVER reassigned below.
        for seq in 5..=24 {
            reg.feed("T", frame(seq, &format!("staged-{seq:03}\r\n"), "S"));
        }
        let completion_target = reg.replay_bounds("T").expect("bounds").head_seq;
        assert_eq!(completion_target, 24);

        // The live producer: one new frame lands between EVERY page/chunk
        // read. The drain pages toward the FIXED target — never the
        // current head — and once the target is covered, the bounded
        // handoff delivers the staged remainder toward the current head,
        // one page budget per lock hold (the producer's single frame per
        // round is cleared many frames per chunk, so it converges).
        let mut produced = 24usize;
        let mut rounds = 0usize;
        let mut completed = false;
        let mut handing_off = false;
        while !completed {
            produced += 1;
            reg.feed(
                "T",
                frame(produced as i64, &format!("live-{produced:03}\r\n"), "S"),
            );
            rounds += 1;
            assert!(
                rounds <= 64,
                "the completion must terminate in bounded rounds (fixed target {completion_target}, \
                 cursor {cursor}, produced {produced})"
            );
            let verdict = if handing_off {
                reg.handoff_paced_tail("T", 1, "paced", cursor, 1024)
            } else {
                reg.complete_paced_tail("T", 1, "paced", cursor, completion_target, 1024)
            };
            match verdict {
                PacedTailCompletion::Handoff {
                    end_seq,
                    serialized_bytes,
                } => {
                    assert!(
                        serialized_bytes <= 1024,
                        "every page/chunk admits at most one page budget per lock hold"
                    );
                    assert!(end_seq > cursor, "pages must make progress");
                    if !handing_off {
                        assert!(
                            end_seq <= completion_target,
                            "drain pages never pass the fixed target"
                        );
                    }
                    cursor = end_seq;
                }
                PacedTailCompletion::TargetCovered {
                    end_seq,
                    serialized_bytes,
                } => {
                    // The FIXED target is covered — NEVER re-captured: the
                    // remainder now flows through the bounded handoff.
                    assert!(
                        serialized_bytes <= 1024,
                        "the target-covering page admits at most one page budget"
                    );
                    assert!(
                        end_seq <= completion_target,
                        "the target-covering page never passes the fixed target"
                    );
                    cursor = end_seq;
                    handing_off = true;
                }
                PacedTailCompletion::Completed { end_seq, .. } => {
                    // Quiet completing hold: everything staged was within
                    // the fixed boundary. The fixture's producer appends
                    // between EVERY round, so the expected shape is the
                    // plan:146 exit below; this arm pins the quiet case.
                    cursor = cursor.max(end_seq);
                    completed = true;
                }
                PacedTailCompletion::CaughtUp => {
                    panic!("a staged remainder exists — the completion must deliver it")
                }
                PacedTailCompletion::Expired { .. } => {
                    panic!("no retention loss in this fixture")
                }
                PacedTailCompletion::GapCompleted {
                    lost_from,
                    lost_to,
                    end_seq,
                    ..
                } => {
                    // THE plan:146 FIXED-BOUNDARY EXIT (round-4): the
                    // session completed AT the fixed boundary — the frames
                    // the producer staged past it are DECLARED as the
                    // exact bounds-carrying delivery gap, never swept,
                    // never chased; the client's bounded baseline recovery
                    // fetches them (the repair attach below).
                    assert_eq!(
                        lost_from,
                        end_seq + 1,
                        "the delivery gap starts just past the completing boundary"
                    );
                    assert_eq!(
                        lost_to, produced as i64,
                        "the delivery gap declares everything staged past the boundary"
                    );
                    cursor = cursor.max(end_seq);
                    completed = true;
                }
                PacedTailCompletion::Gone => panic!("terminal vanished at completion"),
            }
        }
        assert!(
            cursor >= completion_target,
            "the fixed target was covered before completing"
        );
        assert!(
            handing_off,
            "the fixture's producer outran the fixed target, so the post-target \
             remainder must have flowed through the bounded handoff"
        );

        // The delivered stream tiles 1..=cursor contiguously — the pages
        // (≤ target) and the handoff chunks (target, boundary] partition
        // the range with no hole and no duplicate; everything past the
        // boundary is DECLARED (the bounds-carrying delivery gap), never
        // silently lost.
        let handed_off: Vec<i64> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some(o.seq_end),
                _ => None,
            })
            .collect();
        assert_eq!(
            handed_off,
            (5..=cursor).collect::<Vec<_>>(),
            "the completion delivers exactly the staged range, in seq order"
        );
        let mut all: Vec<i64> = delivered.iter().map(|(s, _)| *s).collect();
        all.extend(handed_off);
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (1..=cursor).collect::<Vec<_>>(),
            "the delivered stream is contiguous across the fixed-target boundary"
        );

        // Post-clear output flows through DIRECT fan-out (the deferral
        // cleared at the completing verdict).
        reg.feed("T", frame(cursor + 1, "after-clear\r\n", "S"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalOutput(o)
                    if o.seq_end == cursor + 1)),
            "post-clear output fans out directly to the subscriber"
        );
    }

    /// The fixed-target completion must never admit more than ONE page
    /// budget of data in a single lock hold (round-3 finding: the
    /// completing call bulk-cloned the ENTIRE retained post-target
    /// remainder under the terminal mutex — up to a full ring per
    /// restoring pane — and admitted it to the connection queue outside
    /// every bound). While a producer keeps producing past the fixed
    /// target, the staged post-target remainder grows toward ring
    /// capacity; the completion must still deliver it through the normal
    /// live delivery path, in seq order, with EVERY verdict's admitted
    /// serialized bytes within one page budget.
    #[test]
    fn paced_tail_completion_admits_at_most_one_page_budget_per_lock_hold() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(1024);
        reg.insert_headless("T", "S");
        for seq in 1..=4 {
            reg.feed("T", frame(seq, &format!("data-{seq:03}\r\n"), "S"));
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");

        // Drive the replay to the attach-time target (4).
        let mut cursor = start.session.page_end;
        let mut delivered = page_seq_data(&start.first_page);
        while cursor < 4 {
            match reg.next_replay_page("T", 1, cursor, 4, 1024) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    delivered.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }

        // The staged range below the FIXED completion target (5..=24),
        // then a LARGE post-target remainder (25..=200) produced before
        // the drain even starts — the completing call faces ~176 frames
        // (a multi-page remainder) staged past the target.
        for seq in 5..=24 {
            reg.feed("T", frame(seq, &format!("staged-{seq:03}\r\n"), "S"));
        }
        let completion_target = reg.replay_bounds("T").expect("bounds").head_seq;
        assert_eq!(completion_target, 24);
        for seq in 25..=200 {
            reg.feed("T", frame(seq, &format!("remainder-{seq:03}\r\n"), "S"));
        }

        // The completion target is FIXED and NEVER reassigned below. The
        // drain pages toward it; once it is covered, the staged post-target
        // remainder flows through the bounded post-target handoff — one
        // page budget per lock hold, the "lock" held only per chunk.
        let mut rounds = 0usize;
        let mut per_hold_bytes: Vec<u64> = Vec::new();
        let mut handing_off = false;
        loop {
            rounds += 1;
            assert!(
                rounds <= 256,
                "the completion must terminate in bounded rounds (cursor {cursor}, \
                 target {completion_target})"
            );
            let verdict = if handing_off {
                reg.handoff_paced_tail("T", 1, "paced", cursor, 1024)
            } else {
                reg.complete_paced_tail("T", 1, "paced", cursor, completion_target, 1024)
            };
            match verdict {
                PacedTailCompletion::Handoff {
                    end_seq,
                    serialized_bytes,
                } => {
                    assert!(
                        serialized_bytes <= 1024,
                        "each page/chunk admits at most one page budget per lock hold \
                         (got {serialized_bytes})"
                    );
                    assert!(end_seq > cursor, "pages must make progress");
                    if !handing_off {
                        assert!(
                            end_seq <= completion_target,
                            "pages never pass the fixed target"
                        );
                    }
                    per_hold_bytes.push(serialized_bytes);
                    cursor = end_seq;
                }
                PacedTailCompletion::TargetCovered {
                    end_seq,
                    serialized_bytes,
                } => {
                    // THE ROUND-3 PER-HOLD BOUND at the target boundary: the
                    // target-covering page admits at most ONE page budget —
                    // the staged post-target remainder is NEVER bulk-cloned
                    // in this hold; it flows through the bounded handoff.
                    assert!(
                        serialized_bytes <= 1024,
                        "the completion admits at most one page budget per lock hold \
                         (got {serialized_bytes} bytes — a bulk post-target re-fan)"
                    );
                    assert!(
                        end_seq <= completion_target,
                        "the fixed target is the boundary"
                    );
                    per_hold_bytes.push(serialized_bytes);
                    cursor = end_seq;
                    handing_off = true;
                }
                PacedTailCompletion::Completed {
                    end_seq,
                    serialized_bytes,
                } => {
                    assert!(
                        serialized_bytes <= 1024,
                        "the clearing chunk admits at most one page budget per lock hold \
                         (got {serialized_bytes})"
                    );
                    assert!(
                        end_seq >= 200,
                        "everything staged through the producing head is delivered in \
                         order (end {end_seq}, produced 200)"
                    );
                    per_hold_bytes.push(serialized_bytes);
                    cursor = cursor.max(end_seq);
                    break;
                }
                PacedTailCompletion::CaughtUp => {
                    panic!("a staged remainder exists — the completion must deliver it")
                }
                PacedTailCompletion::Expired { .. } => panic!("no retention loss in this fixture"),
                PacedTailCompletion::GapCompleted { .. } => {
                    panic!("no mid-handoff retention loss in this fixture")
                }
                PacedTailCompletion::Gone => panic!("terminal vanished at completion"),
            }
        }
        assert!(
            per_hold_bytes.len() > 1,
            "a multi-page remainder must never be delivered in one lock hold"
        );
        assert!(
            handing_off,
            "the multi-page post-target remainder must flow through the bounded handoff"
        );

        // The post-target frames arrived through the normal live path, in
        // seq order: the sink's delivered seqs tile (5..=cursor) exactly
        // once, contiguously, across the whole completion.
        let handed_off: Vec<i64> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some(o.seq_end),
                _ => None,
            })
            .collect();
        assert_eq!(
            handed_off,
            (5..=cursor).collect::<Vec<_>>(),
            "the completion delivers exactly the staged range, in seq order"
        );
        let mut all: Vec<i64> = delivered.iter().map(|(s, _)| *s).collect();
        all.extend(handed_off);
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (1..=cursor).collect::<Vec<_>>(),
            "the delivered stream is contiguous across the fixed-target boundary"
        );

        // Post-clear output flows through DIRECT fan-out (the deferral
        // cleared at the completing verdict).
        reg.feed("T", frame(cursor + 1, "after-clear\r\n", "S"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalOutput(o)
                    if o.seq_end == cursor + 1)),
            "post-clear output fans out directly to the subscriber"
        );
    }

    /// The handoff's completion boundary is the head captured ONCE at
    /// completion start (the round-4 fix): the handoff delivers
    /// budget-bounded pages up to that FIXED boundary and ONLY it — never
    /// the terminal's CURRENT head. This fixture models production
    /// AT-OR-ABOVE drain speed the deterministic way: the page budget sits
    /// below one frame's serialized envelope, so EVERY page is the explicit
    /// atomic single-frame page, and the producer appends at least one
    /// frame per page consumed — a handoff that re-reads the head per call
    /// (the pre-fix code) moves its completion boundary with every append
    /// and can NEVER complete (the moving-head chase). The fixed-boundary
    /// handoff completes within the B-DERIVED page bound, the deferral
    /// clears atomically at the completing hold, and the frames the
    /// producer staged past the boundary flow through the normal live
    /// path (the completing hold's live sweep), in seq order.
    #[test]
    fn handoff_completes_at_the_fixed_boundary_against_at_or_above_production() {
        let reg = TerminalRegistry::new();
        // Below every frame's serialized envelope: one atomic frame per
        // page, so one producer frame per page consumed IS at-or-above
        // drain speed (the gated-handoff model the round-4 brief requires).
        reg.set_paced_page_max_bytes(64);
        reg.insert_headless("T", "S");
        for seq in 1..=4 {
            reg.feed("T", frame(seq, &format!("data-{seq:03}\r\n"), "S"));
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink.clone(),
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");

        // Drive the replay to the attach-time target (4).
        let mut cursor = start.session.page_end;
        let mut delivered = page_seq_data(&start.first_page);
        while cursor < 4 {
            match reg.next_replay_page("T", 1, cursor, 4, 64) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    delivered.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }
        assert_eq!(cursor, 4);

        // The staged tail forms the drain window; the FIXED drain target
        // is captured ONCE (exactly what the ws drain task does).
        for seq in 5..=14 {
            reg.feed("T", frame(seq, &format!("staged-{seq:03}\r\n"), "S"));
        }
        let drain_target = reg.replay_bounds("T").expect("bounds").head_seq;
        assert_eq!(drain_target, 14);

        // Phase 1 — the drain pages toward the FIXED target. The producer
        // appends one frame per page consumed here too; the fixed target
        // keeps this phase convergent by construction.
        let mut produced = 14usize;
        let mut pages = 0usize;
        let boundary = loop {
            produced += 1;
            reg.feed(
                "T",
                frame(produced as i64, &format!("live-{produced:03}\r\n"), "S"),
            );
            pages += 1;
            assert!(pages <= 64, "the drain converges to its fixed target");
            match reg.complete_paced_tail("T", 1, "paced", cursor, drain_target, 64) {
                PacedTailCompletion::Handoff { end_seq, .. } => {
                    assert!(end_seq > cursor, "pages must make progress");
                    assert!(end_seq <= drain_target, "pages never pass the fixed target");
                    cursor = end_seq;
                }
                PacedTailCompletion::TargetCovered { end_seq, .. } => {
                    // COMPLETION START: the boundary B is the head captured
                    // ONCE under THIS hold (the fixture is single-threaded,
                    // so the head right after the verdict is exactly it).
                    assert!(
                        end_seq <= drain_target,
                        "the fixed target is the drain boundary"
                    );
                    cursor = end_seq;
                    let boundary = reg.replay_bounds("T").expect("bounds").head_seq;
                    assert!(
                        boundary > drain_target,
                        "the producer staged past the target, so the handoff window is non-empty"
                    );
                    break boundary;
                }
                PacedTailCompletion::Completed { .. } => {
                    panic!("a staged remainder exists past the fixed target")
                }
                PacedTailCompletion::CaughtUp => {
                    panic!("a staged remainder exists — the drain must page it")
                }
                PacedTailCompletion::Expired { .. } => panic!("no retention loss in this fixture"),
                PacedTailCompletion::GapCompleted { .. } => {
                    panic!("the drain phase never takes the mid-handoff exit")
                }
                PacedTailCompletion::Gone => panic!("terminal vanished mid-drain"),
            }
        };

        // THE B-DERIVED PAGE BOUND for the handoff: the window
        // (cursor, boundary] at one frame per page, plus slack for the
        // completing hold. A handoff that chases the per-call head exceeds
        // this bound against the at-or-above producer and never completes.
        let handoff_bound = (boundary - cursor) as usize + 4;
        let mut handoff_pages = 0usize;
        let mut declared_lost_to = 0i64;
        loop {
            // Production at-or-above drain speed: at least one appended
            // frame per page consumed, exactly as the round-4 brief
            // requires (the gated handoff's deterministic model).
            produced += 1;
            reg.feed(
                "T",
                frame(produced as i64, &format!("live-{produced:03}\r\n"), "S"),
            );
            handoff_pages += 1;
            assert!(
                handoff_pages <= handoff_bound,
                "the handoff completes within the B-derived page bound \
                 (boundary {boundary}, cursor {cursor}, pages {handoff_pages}, \
                 bound {handoff_bound}) — a per-call head read is the \
                 moving-head chase"
            );
            match reg.handoff_paced_tail("T", 1, "paced", cursor, 64) {
                PacedTailCompletion::Handoff { end_seq, .. } => {
                    assert!(end_seq > cursor, "chunks must make progress");
                    assert!(
                        end_seq <= boundary,
                        "chunks never pass the FIXED completion boundary"
                    );
                    cursor = end_seq;
                }
                PacedTailCompletion::Completed { end_seq, .. } => {
                    // Quiet completing hold (nothing staged past the
                    // boundary — not this fixture's shape; the arm pins
                    // the quiet contract).
                    cursor = cursor.max(end_seq);
                    break;
                }
                PacedTailCompletion::CaughtUp => break,
                PacedTailCompletion::TargetCovered { .. } => {
                    panic!("the handoff never re-targets: a covered boundary completes")
                }
                PacedTailCompletion::Expired { .. } => {
                    panic!("no retention loss in this fixture")
                }
                PacedTailCompletion::GapCompleted {
                    lost_from,
                    lost_to,
                    end_seq,
                    reason,
                    ..
                } => {
                    // THE plan:146 FIXED-BOUNDARY EXIT: the session
                    // completed AT B; the frames the producer staged past
                    // B are DECLARED as the exact bounds-carrying
                    // delivery gap — never swept (plan:145), never chased.
                    assert_eq!(
                        lost_from,
                        end_seq + 1,
                        "the delivery gap starts just past the fixed boundary"
                    );
                    assert_eq!(
                        lost_to, produced as i64,
                        "the delivery gap declares everything staged past the boundary \
                         through the producing head"
                    );
                    // Round-5 finding 3: the diagnostics carry the
                    // mandatory gap-exit reason — the ORDINARY fetchable
                    // fixed-boundary residual exit, never a retention
                    // overrun (the declared interval is RETAINED and the
                    // client's checkpoint-cursor repair fetches it).
                    assert_eq!(
                        reason,
                        PacedGapExitReason::HandoffBoundaryResidual,
                        "the fixed-boundary residual's GapCompleted carries the \
                         handoff_boundary_residual reason (structured diagnostics \
                         consumers filter on)"
                    );
                    declared_lost_to = lost_to;
                    cursor = cursor.max(end_seq);
                    break;
                }
                PacedTailCompletion::Gone => panic!("terminal vanished mid-handoff"),
            }
        }
        assert!(
            cursor >= boundary,
            "the handoff covered the fixed completion boundary"
        );
        let boundary_at_completion = cursor;

        // The delivered stream tiles (5..=boundary_at_completion) exactly
        // once, in seq order: the drain pages plus the handoff chunks; the
        // frames past the boundary are DECLARED, never silently lost.
        let handed_off: Vec<i64> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) if o.seq_end > 4 => Some(o.seq_end),
                _ => None,
            })
            .collect();
        assert_eq!(
            handed_off,
            (5..=boundary_at_completion).collect::<Vec<_>>(),
            "drain pages + handoff chunks tile the session's window exactly \
             once, in seq order — the boundary exit declares (never \
             delivers) the residual past it"
        );
        let mut all: Vec<i64> = delivered.iter().map(|(s, _)| *s).collect();
        all.extend(handed_off);
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (1..=boundary_at_completion).collect::<Vec<_>>(),
            "the delivered stream is contiguous across the whole completion"
        );
        // The exact bounds-carrying delivery gap was sunk through the
        // subscriber's sink, ordered after the chunk that covered B.
        let stream = seen.lock().unwrap().clone();
        let gap = stream
            .iter()
            .find(|m| {
                matches!(m, ServerMessage::TerminalOutputGap(g)
                if g.from_seq == boundary_at_completion + 1
                    && g.to_seq == declared_lost_to)
            })
            .expect("the exact bounds-carrying delivery gap for the residual");
        assert!(
            matches!(gap, ServerMessage::TerminalOutputGap(g)
                if g.reason == TerminalOutputGapReason::HandoffBoundaryReached),
            "the residual exit declares the handoff_boundary_reached delivery gap: {gap:?}"
        );

        // Post-clear output flows through DIRECT fan-out (the deferral
        // cleared at the completing hold): a frame appended after the
        // completion reaches the subscriber with no handoff call at all.
        let seen_len = seen.lock().unwrap().len();
        reg.feed(
            "T",
            frame(boundary_at_completion + 1, "after-clear\r\n", "S"),
        );
        assert!(
            seen.lock().unwrap().len() > seen_len,
            "post-clear output fans out directly to the subscriber"
        );

        // The declared interval is FETCHABLE (the ring retained it): the
        // client's bounded baseline recovery — the repair attach from the
        // coverage cursor (the queue_overflow repair contract) — fetches
        // it as a fresh bounded paced session, so the post-boundary
        // frames ARRIVE via the normal paced page path, in order.
        let head_after = reg.replay_bounds("T").expect("bounds").head_seq;
        let out2 = reg.attach(
            "T",
            1,
            sink,
            Some("paced-repair".into()),
            boundary_at_completion,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let repair = out2.paced.expect("the repair paced session");
        let mut repair_delivered = page_seq_data(&repair.first_page);
        let mut repair_cursor = repair.session.page_end;
        while repair_cursor < head_after {
            match reg.next_replay_page("T", 1, repair_cursor, head_after, 64) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    repair_delivered.extend(page_seq_data(&messages));
                    repair_cursor = end_seq;
                }
                other => panic!("unexpected repair replay read: {other:?}"),
            }
        }
        let repair_seqs: Vec<i64> = repair_delivered.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            repair_seqs,
            (boundary_at_completion + 1..=head_after).collect::<Vec<i64>>(),
            "the repair session pages the declared interval in order — the \
             post-B frames arrive via the normal path"
        );
    }

    /// Retention overrun past the handoff cursor mid-handoff is the plan:146
    /// BOUNDED-BASELINE EXIT (round-4): the exact bounds-carrying gap for
    /// the evicted interval, then the session COMPLETES AT THE RING FRONT
    /// with the gap recorded — never a resumption of the paged handoff
    /// toward an unreachable boundary (the pre-fix code resumed the chase
    /// from the ring front: `Expired` + continue). The retained window
    /// (ring front, head] flows through the normal live path in the same
    /// completing hold, in seq order, so the delivered stream is contiguous
    /// except exactly the declared gap; the deferral clears atomically and
    /// live output resumes directly.
    #[test]
    fn handoff_retention_overrun_declares_the_gap_and_completes_at_the_ring_front() {
        let reg = TerminalRegistry::new();
        // Tiny CHAR ring so feeding evicts the front deterministically.
        reg.set_scrollback_max_bytes(60);
        reg.set_paced_page_max_bytes(0); // per-frame pages: deterministic cursor control
        reg.insert_headless("T", "S");
        for seq in 1..=3 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S")); // 10 chars each
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink.clone(),
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");

        // Drive the replay to the attach-time target (3).
        let mut cursor = start.session.page_end;
        let mut delivered = page_seq_data(&start.first_page);
        while cursor < 3 {
            match reg.next_replay_page("T", 1, cursor, 3, 0) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    delivered.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }
        assert_eq!(cursor, 3);

        // Stage the drain window (4..=5) and then production past it
        // (6..=7): 30 + 20 + 20 = 70 chars > the 60-char ring, so frame 1
        // evicts — the drain window stays retained.
        for seq in 4..=5 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S"));
        }
        let drain_target = reg.replay_bounds("T").expect("bounds").head_seq;
        assert_eq!(drain_target, 5);
        for seq in 6..=7 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S"));
        }

        // Phase 1 — the drain pages its fixed target (per-frame pages) with
        // frames staged past it: TargetCovered, and the boundary B is the
        // head at that hold (7).
        let verdict = loop {
            match reg.complete_paced_tail("T", 1, "paced", cursor, drain_target, 0) {
                PacedTailCompletion::Handoff { end_seq, .. } => {
                    assert!(end_seq > cursor, "pages must make progress");
                    cursor = end_seq;
                }
                verdict @ PacedTailCompletion::TargetCovered { .. } => break verdict,
                other => panic!("the drain must cover its fixed target, got {other:?}"),
            }
        };
        match verdict {
            PacedTailCompletion::TargetCovered { end_seq, .. } => {
                assert_eq!(end_seq, 5);
                cursor = end_seq;
            }
            _ => unreachable!("the loop above only breaks on TargetCovered"),
        }
        let boundary = reg.replay_bounds("T").expect("bounds").head_seq;
        assert_eq!(
            boundary, 7,
            "the completion boundary is the head at completion start"
        );

        // Retention OVERRUNS the handoff cursor mid-handoff: feed far past
        // the 60-char ring so the ring front passes seq 5 (the cursor).
        for seq in 8..=12 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S"));
        }
        let bounds = reg.replay_bounds("T").expect("bounds");
        assert!(
            bounds.oldest_retained_seq > cursor + 1,
            "the fixture evicted the frames the handoff needs next \
             (front {} vs cursor {cursor})",
            bounds.oldest_retained_seq
        );

        // THE plan:146 EXIT: the handoff call must COMPLETE the session —
        // TWO exact bounds-carrying gaps sunk in the overrun's completing
        // hold (the retention gap for the evicted interval, then the
        // delivery gap for the retained window the session will not
        // deliver), then the atomic clear. The pre-fix code returned
        // `Expired` and resumed the paged chase from the ring front (its
        // tests drove that continuation); this assertion is the round-4
        // RED.
        let seen_len_at_overrun = seen.lock().unwrap().len();
        let verdict = reg.handoff_paced_tail("T", 1, "paced", cursor, 0);
        match verdict {
            PacedTailCompletion::Expired { .. } => {
                panic!(
                    "the retention overrun must COMPLETE at the ring front with the \
                     gaps recorded — resuming the paged handoff toward an unreachable \
                     boundary is the plan:146 violation"
                )
            }
            PacedTailCompletion::TargetCovered { .. } => {
                panic!("the handoff never re-targets: a covered boundary completes")
            }
            PacedTailCompletion::GapCompleted {
                lost_from,
                lost_to,
                end_seq,
                reason,
                ..
            } => {
                assert_eq!(
                    lost_from,
                    cursor + 1,
                    "the retention gap starts at cursor+1"
                );
                assert_eq!(
                    lost_to,
                    bounds.oldest_retained_seq - 1,
                    "the retention gap ends just before the new ring front"
                );
                assert_eq!(
                    end_seq, cursor,
                    "the session's delivered-through boundary stays at the cursor — \
                     nothing is swept in the exit hold (plan:145)"
                );
                // Round-5 finding 3: the diagnostics carry the mandatory
                // gap-exit reason — a genuine retention overrun (the lost
                // interval is UNFETCHABLE), never the fetchable
                // fixed-boundary residual exit.
                assert_eq!(
                    reason,
                    PacedGapExitReason::RetentionOverrun,
                    "the mid-handoff retention overrun's GapCompleted carries the \
                     retention_overrun reason (structured diagnostics consumers \
                     filter on)"
                );
            }
            PacedTailCompletion::Completed { .. } | PacedTailCompletion::CaughtUp => {
                panic!("the overrun must take the gap-completed exit")
            }
            other => panic!("the overrun must complete the session, got {other:?}"),
        }

        // Both exact gaps reached the subscriber IN ORDER in the
        // completing hold — the retention gap for the evicted interval
        // first, then the handoff_boundary_reached delivery gap declaring
        // the retained window the session will not deliver.
        let stream = seen.lock().unwrap().clone();
        let retention_gap_index = stream
            .iter()
            .position(|m| {
                matches!(m, ServerMessage::TerminalOutputGap(g)
                if g.from_seq == cursor + 1
                    && g.to_seq == bounds.oldest_retained_seq - 1
                    && g.reason == TerminalOutputGapReason::ReplayWindowExceeded)
            })
            .expect("the retention gap for the evicted interval");
        assert!(
            retention_gap_index >= seen_len_at_overrun,
            "the retention gap was sunk by the overrun's completing hold"
        );
        let delivery_gap_index = stream
            .iter()
            .position(|m| {
                matches!(m, ServerMessage::TerminalOutputGap(g)
                if g.from_seq == bounds.oldest_retained_seq
                    && g.to_seq == bounds.head_seq
                    && g.reason == TerminalOutputGapReason::HandoffBoundaryReached)
            })
            .expect("the delivery gap declaring the retained window");
        assert!(
            delivery_gap_index > retention_gap_index,
            "the delivery gap follows the retention gap in sink order"
        );
        for msg in stream.iter().skip(delivery_gap_index + 1) {
            if let ServerMessage::TerminalOutputGap(g) = msg {
                assert!(
                    g.from_seq > cursor,
                    "no third loss was declared after the overrun exit: {g:?}"
                );
            }
        }

        // The session is OVER: the deferral cleared (post-clear output
        // fans out directly), and a further handoff call is refused.
        let seen_len_after = seen.lock().unwrap().len();
        reg.feed("T", frame(bounds.head_seq + 1, "after-clear\r\n", "S"));
        assert!(
            seen.lock().unwrap().len() > seen_len_after,
            "post-clear output fans out directly — the deferral cleared at the \
             ring-front completion"
        );
        match reg.handoff_paced_tail("T", 1, "paced", bounds.head_seq, 0) {
            PacedTailCompletion::Gone => {}
            other => panic!("a completed session refuses further handoff calls, got {other:?}"),
        }

        // The declared retained window is FETCHABLE: the client's bounded
        // baseline recovery (the repair attach from the coverage cursor)
        // is retention-adjusted to the ring front and pages the retained
        // window in order — the post-gap frames arrive via the normal
        // paced page path, contiguously after the declared loss.
        let repair_bounds = reg.replay_bounds("T").expect("bounds");
        let out2 = reg.attach(
            "T",
            1,
            sink,
            Some("paced-repair".into()),
            cursor,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let repair = out2.paced.expect("the repair paced session");
        assert_eq!(
            repair.session.effective_since,
            repair_bounds.oldest_retained_seq - 1,
            "the repair's baseline is retention-adjusted to the ring front"
        );
        let mut repair_delivered = page_seq_data(&repair.first_page);
        let mut repair_cursor = repair.session.page_end;
        while repair_cursor < repair.session.target {
            match reg.next_replay_page("T", 1, repair_cursor, repair.session.target, 0) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    repair_delivered.extend(page_seq_data(&messages));
                    repair_cursor = end_seq;
                }
                other => panic!("unexpected repair replay read: {other:?}"),
            }
        }
        let repair_seqs: Vec<i64> = repair_delivered.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            repair_seqs,
            (repair_bounds.oldest_retained_seq..=repair_bounds.head_seq).collect::<Vec<i64>>(),
            "the repair session pages the declared retained window in order"
        );
    }

    /// A superseded drain generation must never touch the new session's
    /// deferral (the off-dispatcher drain's generation guard): the drain
    /// task runs concurrently with the connection dispatcher, so a
    /// re-attach mid-drain replaces the subscriber's attach generation
    /// while the OLD drain is still paging. The old drain's page reads
    /// must come back GONE for the superseded generation — an unguarded
    /// read would page with the NEW generation's stamp and, worse, its
    /// "drained" verdict would CLEAR the new session's deferral,
    /// letting live output overtake the new session's pages.
    #[test]
    fn superseded_drain_generation_never_clears_the_new_sessions_deferral() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(0); // per-frame pages: deterministic control
        reg.insert_headless("T", "S");
        for seq in 1..=4 {
            reg.feed("T", frame(seq, &format!("data-{seq:03}\r\n"), "S"));
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink.clone(),
            Some("arid-gen-1".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");
        assert_eq!(start.session.page_end, 1, "per-frame pages: one frame");

        // The old generation's drain reaches the current head (a caught-up
        // call would clear the deferral — for ITS OWN generation).
        let old_cursor = 4;
        // Production continues; then generation 2 re-attaches mid-drain
        // (the registry replaces the subscriber: a NEW attach generation
        // stamped on the SAME (connection, terminal), deferral re-armed,
        // its own first page delivered).
        for seq in 5..=8 {
            reg.feed("T", frame(seq, &format!("more-{seq:03}\r\n"), "S"));
        }
        let out2 = reg.attach(
            "T",
            1,
            sink,
            Some("arid-gen-2".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start2 = out2.paced.expect("paced session 2");
        assert_eq!(
            start2.session.page_end, 1,
            "gen-2's own first page restarts at the baseline"
        );
        let seen_len_after_reattach = seen.lock().unwrap().len();

        // The OLD drain's next call (still mid-flight off-dispatch):
        // against the CURRENT 5-arg API this reads the subscriber with NO
        // generation guard — the drain this test pins must refuse to
        // touch the superseded subscriber.
        let verdict = reg.complete_paced_tail("T", 1, "arid-gen-1", old_cursor, old_cursor, 1024);
        match verdict {
            PacedTailCompletion::Gone => {
                // The guarded behavior: the superseded generation's drain
                // is cancelled without delivering or clearing anything.
            }
            PacedTailCompletion::CaughtUp | PacedTailCompletion::Completed { .. } => {
                panic!(
                    "the superseded drain's verdict cleared gen-2's deferral — \
                      live output would overtake gen-2's pages"
                )
            }
            other => {
                panic!("the superseded drain must be refused, got {other:?}");
            }
        }
        assert_eq!(
            seen.lock().unwrap().len(),
            seen_len_after_reattach,
            "the superseded drain delivers NOTHING"
        );

        // Gen-2's deferral is still armed: new production STAGES (no
        // direct fan-out) while gen-2's session is mid-replay.
        reg.feed("T", frame(9, "while-deferred\r\n", "S"));
        assert!(
            !seen
                .lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalOutput(o) if o.seq_end == 9)),
            "gen-2's deferral stays armed — the frame stages, it does not fan out"
        );

        // Gen-2's own session pages the full retained window in order —
        // including the staged frame 9 — and completes through the
        // arid-guarded reads.
        let mut cursor = start2.session.page_end;
        let target2 = start2.session.target;
        let mut guards = 0;
        let mut handing_off = false;
        loop {
            guards += 1;
            assert!(guards <= 64, "gen-2 drains in bounded rounds");
            let verdict = if handing_off {
                reg.handoff_paced_tail("T", 1, "arid-gen-2", cursor, 1024)
            } else {
                reg.complete_paced_tail("T", 1, "arid-gen-2", cursor, target2, 1024)
            };
            match verdict {
                PacedTailCompletion::Handoff { end_seq, .. } => cursor = end_seq,
                PacedTailCompletion::GapCompleted { .. } => {
                    panic!("no mid-handoff retention loss in this fixture")
                }
                PacedTailCompletion::TargetCovered { end_seq, .. } => {
                    // Fixed target covered with a staged remainder beyond:
                    // the bounded post-target handoff owns it.
                    cursor = end_seq;
                    handing_off = true;
                }
                PacedTailCompletion::Completed { end_seq, .. } => {
                    cursor = cursor.max(end_seq);
                    break;
                }
                PacedTailCompletion::CaughtUp => break,
                PacedTailCompletion::Expired { .. } => panic!("no retention loss here"),
                PacedTailCompletion::Gone => panic!("gen-2 is the live generation"),
            }
        }
        assert_eq!(cursor, 9, "gen-2 drains through the staged frame");
        reg.feed("T", frame(10, "after-clear\r\n", "S"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalOutput(o) if o.seq_end == 10)),
            "post-clear output fans out directly after gen-2's completion"
        );
    }

    /// Round-2 finding F2 — the DEFENSE-IN-DEPTH pin: a single frame whose
    /// own envelope exceeds the page budget still forms its own atomic
    /// single-frame page (guaranteed progress, never split, never silently
    /// coalesced into a "budget" page). UNREACHABLE under supported
    /// settings: every PTY byte is ingested through the fragment splitter
    /// whose cap is clamped to [`crate::fragment::PACED_PAGE_BUDGET_FLOOR_BYTES`]
    /// (the smallest page budget any supported queue setting can produce),
    /// so a production frame can never exceed the page budget — this arm
    /// exists exactly for the unsupported residue (a test-injected budget
    /// below the floor, a future ingest path that bypasses the splitter)
    /// and must never be removed.
    #[test]
    fn paced_replay_oversized_frame_atomic_page_is_defense_in_depth_beyond_the_boot_clamp() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(256);
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "tiny-a\r\n", "S"));
        reg.feed("T", frame(2, &"X".repeat(2048), "S"));
        reg.feed("T", frame(3, "tiny-b\r\n", "S"));

        let (sink, _seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");
        assert_eq!(
            start.session.page_end, 1,
            "the first page stops before the oversize frame"
        );

        match reg.next_replay_page("T", 1, 1, 3, 256) {
            PacedPage::Frames {
                messages,
                end_seq,
                serialized_bytes,
            } => {
                assert_eq!(end_seq, 2);
                assert_eq!(
                    messages.len(),
                    1,
                    "the oversize frame is ONE atomic message"
                );
                assert!(
                    serialized_bytes as usize > 256,
                    "the oversize frame honestly exceeds the budget as its own page"
                );
                match &messages[0] {
                    ServerMessage::TerminalOutput(o) => {
                        assert_eq!(o.seq_start, 2);
                        assert_eq!(o.data.len(), 2048);
                    }
                    other => panic!("per-frame subscriber gets terminal.output: {other:?}"),
                }
            }
            other => panic!("expected the atomic oversize page, got {other:?}"),
        }
        match reg.next_replay_page("T", 1, 2, 3, 256) {
            PacedPage::Frames {
                messages, end_seq, ..
            } => {
                assert_eq!(end_seq, 3);
                assert_eq!(
                    page_seq_data(&messages),
                    vec![(3, "tiny-b\r\n".to_string())]
                );
            }
            other => panic!("expected the final page, got {other:?}"),
        }
    }

    /// Retention expiry mid-replay: the exact lost interval and the resume
    /// position, both consistent with the ring's live bounds.
    #[test]
    fn paced_replay_expired_reports_the_exact_interval_and_resume() {
        let reg = TerminalRegistry::new();
        // Tiny CHAR ring so feeding evicts the front deterministically.
        reg.set_scrollback_max_bytes(60);
        reg.insert_headless("T", "S");
        reg.set_paced_page_max_bytes(0); // per-frame pages: deterministic cursor control
        for seq in 1..=3 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S")); // 10 chars each
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");
        assert_eq!(start.session.page_end, 1, "budget 0 => one frame per page");

        // Evict frames 2..: 10 more chunks (100 chars) pushes the front well
        // past the session cursor.
        for seq in 4..=13 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S"));
        }
        let bounds = reg.replay_bounds("T").expect("bounds");
        assert!(
            bounds.oldest_retained_seq > 2,
            "the fixture evicted the frames the session needs next"
        );

        match reg.next_replay_page("T", 1, 1, bounds.head_seq, 0) {
            PacedPage::Expired {
                lost_from,
                lost_to,
                resume_from,
                head_seq,
                oldest_retained_seq,
            } => {
                assert_eq!(lost_from, 2, "the lost interval starts at cursor+1");
                assert_eq!(
                    lost_to,
                    bounds.oldest_retained_seq - 1,
                    "the lost interval ends just before the new ring front"
                );
                assert_eq!(resume_from, bounds.oldest_retained_seq - 1);
                assert_eq!(head_seq, bounds.head_seq);
                assert_eq!(oldest_retained_seq, bounds.oldest_retained_seq);
            }
            other => panic!("expected Expired, got {other:?}"),
        }

        // Continuation from the new baseline: the drain pages everything
        // the ring still holds toward the FIXED drain target (quiet
        // terminal — the head), then the completing verdict clears the
        // deferral.
        let drain_target = reg.replay_bounds("T").expect("bounds").head_seq;
        let mut tail_cursor = bounds.oldest_retained_seq - 1;
        let mut rounds = 0;
        loop {
            rounds += 1;
            assert!(rounds <= 64, "the quiet drain terminates in bounded rounds");
            match reg.complete_paced_tail("T", 1, "paced", tail_cursor, drain_target, 0) {
                PacedTailCompletion::CaughtUp => break,
                PacedTailCompletion::Completed { end_seq, .. } => {
                    tail_cursor = tail_cursor.max(end_seq);
                    break;
                }
                PacedTailCompletion::Handoff { end_seq, .. } => {
                    assert!(end_seq <= drain_target, "pages never pass the fixed target");
                    tail_cursor = end_seq;
                }
                other => panic!("a quiet terminal completes its drain, got {other:?}"),
            }
        }
        assert_eq!(tail_cursor, bounds.head_seq);
        let drained_seqs: Vec<i64> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) if o.seq_start >= bounds.oldest_retained_seq => {
                    Some(o.seq_start)
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            drained_seqs,
            (bounds.oldest_retained_seq..=bounds.head_seq).collect::<Vec<_>>(),
            "the continuation covers exactly the retained range"
        );
    }

    /// While a paced session is active the subscriber's live output is NOT
    /// sunk by ingest (the ring is the staging); after the session catches
    /// up (deferral cleared under the tail read's lock), ingest resumes
    /// direct delivery. Concurrent production across the flag-clear
    /// boundary is delivered exactly once — paged or direct, never both,
    /// never neither.
    #[test]
    fn paced_deferral_stages_live_output_and_resumes_direct_delivery_exactly_once() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(0); // per-frame pages
        reg.insert_headless("T", "S");
        for seq in 1..=3 {
            reg.feed("T", frame(seq, "early-1\r\n", "S"));
        }
        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out.paced.expect("paced session");
        assert_eq!(start.session.page_end, 1);

        // Live output while the session is active: staged in the ring, NOT
        // sunk.
        reg.feed("T", frame(4, "live-04\r\n", "S"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .all(|m| !matches!(m, ServerMessage::TerminalOutput(_))),
            "deferred subscriber receives nothing inline"
        );

        // Concurrent production racing the tail drain.
        let feeder_reg = reg.clone();
        let feeder = std::thread::spawn(move || {
            for seq in 5..=40 {
                feeder_reg.feed("T", frame(seq, &format!("race-{seq:02}\r\n"), "S"));
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        });

        // Drain: replay pages to the target (returned to this caller), then
        // the paged drain toward the FIXED drain target (the head at drain
        // start — the feeder races it), then the fixed-target atomic live
        // handoff (drained clear or re-fan; the feeder's staged frames are
        // delivered through the subscriber's sink, recorded in `seen`
        // alongside the direct deliveries below).
        let mut collected = page_seq_data(&start.first_page);
        let mut cursor = start.session.page_end;
        while cursor < start.session.target {
            match reg.next_replay_page("T", 1, cursor, start.session.target, 0) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    collected.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }
        let drain_target = reg.replay_bounds("T").expect("bounds").head_seq;
        let mut rounds = 0;
        let mut handing_off = false;
        loop {
            rounds += 1;
            assert!(
                rounds <= 128,
                "the racing drain terminates in bounded rounds"
            );
            let verdict = if handing_off {
                reg.handoff_paced_tail("T", 1, "paced", cursor, 0)
            } else {
                reg.complete_paced_tail("T", 1, "paced", cursor, drain_target, 0)
            };
            match verdict {
                PacedTailCompletion::CaughtUp | PacedTailCompletion::Completed { .. } => break,
                PacedTailCompletion::Handoff { end_seq, .. } => {
                    if !handing_off {
                        assert!(end_seq <= drain_target, "pages never pass the fixed target");
                    }
                    cursor = end_seq;
                }
                PacedTailCompletion::GapCompleted { .. } => {
                    panic!("no retention loss in this fixture (feeder max 41 frames)")
                }
                PacedTailCompletion::TargetCovered { end_seq, .. } => {
                    // Fixed target covered with the feeder still staging:
                    // the bounded post-target handoff delivers the racing
                    // remainder one frame-chunk per lock hold.
                    cursor = end_seq;
                    handing_off = true;
                }
                PacedTailCompletion::Expired { .. } => {
                    panic!("no retention loss in this fixture (feeder max 41 frames)")
                }
                PacedTailCompletion::Gone => panic!("terminal vanished at completion"),
            }
        }
        feeder.join().expect("feeder joins");

        // Post-clear production flows DIRECTLY through ingest again. The
        // feeder's tail may have landed either side of the clear (any split
        // is valid); frame 41 is fed strictly AFTER the drain, so it must be
        // a DIRECT delivery.
        reg.feed("T", frame(41, "after-41\r\n", "S"));
        let direct: Vec<(i64, String)> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some((o.seq_start, o.data.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            direct.last(),
            Some(&(41, "after-41\r\n".to_string())),
            "post-clear output is delivered directly by ingest: {direct:?}"
        );

        // The no-loss/no-dup invariant across the flag-clear boundary:
        // pages + direct deliveries together are exactly frames 1..=41, once.
        let mut all: Vec<(i64, String)> = collected;
        all.extend(direct);
        all.sort_by_key(|(s, _)| *s);
        let seqs: Vec<i64> = all.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            seqs,
            (1..=41).collect::<Vec<_>>(),
            "every produced frame delivered exactly once, in seq order"
        );
        assert_eq!(all.iter().map(|(_, d)| d.clone()).collect::<String>(), {
            let mut s = String::new();
            for _seq in 1..=3 {
                s.push_str("early-1\r\n");
            }
            s.push_str("live-04\r\n");
            for seq in 5..=40 {
                s.push_str(&format!("race-{seq:02}\r\n"));
            }
            s.push_str("after-41\r\n");
            s
        });
    }

    /// A re-attach replaces the subscriber — an armed paced deferral does not
    /// survive into the new subscription unless the new attach arms its own.
    #[test]
    fn reattach_replaces_the_paced_deferral() {
        let reg = TerminalRegistry::new();
        reg.set_paced_page_max_bytes(0);
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "one\r\n", "S"));

        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink.clone(),
            Some("paced-a".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(out.paced.is_some(), "the paced attach arms the deferral");
        reg.feed("T", frame(2, "two\r\n", "S"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .all(|m| !matches!(m, ServerMessage::TerminalOutput(_))),
            "staged while the first session is active"
        );

        // A non-paced re-attach (the fallback shape) cancels the session's
        // deferral: the legacy re-attach replays the window INLINE (frames 1
        // and 2 — including the one staged while deferred), and the NEXT
        // produced frame flows directly by ingest, with no pages to drive.
        let out2 = reg.attach(
            "T",
            1,
            sink.clone(),
            Some("legacy-b".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(
            out2.paced.is_none(),
            "a non-negotiated re-attach stays legacy"
        );
        reg.feed("T", frame(3, "three\r\n", "S"));
        let live: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) if o.source == Some(OutputSource::Live) => {
                    Some(o.data.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            live,
            vec!["three\r\n".to_string()],
            "after the deferral clears, live output flows directly"
        );

        // A paced re-attach arms a FRESH session whose first page includes
        // everything staged since its own baseline.
        let out3 = reg.attach(
            "T",
            1,
            sink.clone(),
            Some("paced-c".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let start = out3
            .paced
            .expect("the paced re-attach starts a fresh session");
        assert_eq!(start.session.attach_request_id, "paced-c");
        assert_eq!(start.session.target, 3);
        // Budget 0 => per-frame pages: drive the fresh session to completion
        // and assert it pages the WHOLE window (including frame 2, staged
        // while the first session was deferred).
        let mut paged: Vec<(i64, String)> = page_seq_data(&start.first_page);
        let mut cursor = start.session.page_end;
        while cursor < start.session.target {
            match reg.next_replay_page("T", 1, cursor, start.session.target, 0) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    paged.extend(page_seq_data(&messages));
                    cursor = end_seq;
                }
                other => panic!("unexpected replay read: {other:?}"),
            }
        }
        let mut paged_seqs: Vec<i64> = paged.iter().map(|(s, _)| *s).collect();
        paged_seqs.sort_unstable();
        assert_eq!(
            paged_seqs,
            vec![1, 2, 3],
            "the fresh session pages the whole window"
        );
    }

    /// Retention loss AT ATTACH (requested since predates the retained
    /// ring): the negotiated connection gets the retention gap with the
    /// task-2 bounds fields, `replayResetReason: retention_lost`, and an
    /// effective baseline of `oldest-1` — the session continues from what
    /// is retained (nothing is killed, nothing stalls).
    #[test]
    fn paced_attach_with_retention_loss_emits_the_negotiated_gap_and_resets_the_baseline() {
        let reg = TerminalRegistry::new();
        reg.set_scrollback_max_bytes(60);
        reg.insert_headless("T", "S");
        for seq in 1..=13 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S"));
        }
        let bounds = reg.replay_bounds("T").expect("bounds");
        assert!(
            bounds.oldest_retained_seq > 1,
            "the front has evicted past seq 1"
        );

        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(out.found);
        let start = out
            .paced
            .expect("paced session continues from what is retained");
        assert_eq!(
            start.session.effective_since,
            bounds.oldest_retained_seq - 1,
            "the baseline resets to oldest-1"
        );
        assert_eq!(start.session.target, bounds.head_seq);
        let first = page_seq_data(&start.first_page);
        assert_eq!(
            first.first().unwrap().0,
            bounds.oldest_retained_seq,
            "the first page starts at the retained front"
        );

        let ready = attach_ready(&seen).expect("attach.ready sent");
        assert_eq!(
            ready.replay_reset_reason,
            Some(TerminalReplayResetReason::RetentionLost),
            "the ready frame names the retention reset"
        );
        assert_eq!(ready.oldest_retained_seq, Some(bounds.oldest_retained_seq));
        assert_eq!(
            ready.effective_since_seq,
            Some(bounds.oldest_retained_seq - 1)
        );
        assert_eq!(ready.requested_since_seq, Some(0));
        assert_eq!(ready.replay_from_seq, bounds.oldest_retained_seq);
        assert_eq!(ready.replay_to_seq, bounds.head_seq);

        let gap = seen
            .lock()
            .unwrap()
            .iter()
            .find_map(|m| match m {
                ServerMessage::TerminalOutputGap(g) => Some(g.clone()),
                _ => None,
            })
            .expect("the retention gap is sunk with the ready prelude");
        assert_eq!(
            gap.reason,
            freshell_protocol::TerminalOutputGapReason::ReplayWindowExceeded
        );
        assert_eq!(
            gap.from_seq, 1,
            "the lost interval starts at the requested baseline+1"
        );
        assert_eq!(gap.to_seq, bounds.oldest_retained_seq - 1);
        assert_eq!(gap.attach_request_id.as_deref(), Some("paced"));
        assert_eq!(gap.head_seq, Some(bounds.head_seq));
        assert_eq!(gap.oldest_retained_seq, Some(bounds.oldest_retained_seq));
    }

    /// The compatibility twin: a NON-negotiated attach with the same
    /// retention loss keeps today's silent behavior — no gap frame, no reset
    /// reason, no retention bounds, replay silently starting at the ring
    /// front.
    #[test]
    fn plain_attach_with_retention_loss_stays_silent_and_byte_identical() {
        let reg = TerminalRegistry::new();
        reg.set_scrollback_max_bytes(60);
        reg.insert_headless("T", "S");
        for seq in 1..=13 {
            reg.feed("T", frame(seq, "chunk123\r\n", "S"));
        }
        let bounds = reg.replay_bounds("T").expect("bounds");

        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("plain".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(
            out.paced.is_none(),
            "non-negotiated never starts a paced session"
        );
        let ready = attach_ready(&seen).expect("attach.ready sent");
        assert_eq!(ready.replay_reset_reason, None);
        assert_eq!(ready.oldest_retained_seq, None);
        assert_eq!(ready.replay_from_seq, bounds.oldest_retained_seq);
        let frames = outputs(&seen);
        assert_eq!(
            frames.first().map(|f| f.seq_start),
            Some(bounds.oldest_retained_seq),
            "legacy replay silently starts at the retained front"
        );
        assert!(
            !seen
                .lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalOutputGap(_))),
            "no gap frame for a non-negotiated connection"
        );
    }

    /// A negotiated attach to an ALREADY-EXITED terminal keeps the legacy
    /// inline path (frozen-tail replay + synthetic exit, in their legacy
    /// order): pacing arms only for Running terminals this increment.
    #[test]
    fn paced_negotiation_on_an_exited_terminal_keeps_the_legacy_inline_path() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "tail\r\n", "S"));
        assert!(reg.finish_pty_exit("T", 0));

        let (sink, seen) = collector();
        let out = reg.attach(
            "T",
            1,
            sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(
            out.paced.is_none(),
            "exited terminals stay on the legacy path"
        );
        let frames = outputs(&seen);
        assert_eq!(frames.len(), 1, "the frozen tail replays inline");
        assert_eq!(frames[0].source, Some(OutputSource::Replay));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalExit(_))),
            "the synthetic exit follows the inline replay"
        );
    }

    /// TERM-07 seam: the attach-threaded `maxReplayBytes` is recorded on the
    /// subscriber with NO delivery-behavior change (it stays unread for
    /// delivery decisions this increment; the increment-3 snapshot work
    /// consumes it).
    #[test]
    fn attach_records_max_replay_bytes_on_the_subscriber() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "one\r\n", "S"));
        let (sink, _seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            Some(128 * 1024),
            PacedAttachOptions::default(),
        );
        let recorded = {
            let inner = reg.inner.lock().unwrap();
            let handle = inner.terminals.get("T").unwrap();
            let s = handle.shared.lock().unwrap();
            s.subscribers
                .get(&1)
                .expect("subscriber installed")
                .max_replay_bytes
        };
        assert_eq!(recorded, Some(128 * 1024));

        // Absent stays absent; the legacy path threads it identically.
        let (sink2, _seen2) = collector();
        let _ = reg.attach(
            "T",
            2,
            sink2,
            Some("b".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let recorded2 = {
            let inner = reg.inner.lock().unwrap();
            let handle = inner.terminals.get("T").unwrap();
            let s = handle.shared.lock().unwrap();
            s.subscribers.get(&2).expect("subscriber").max_replay_bytes
        };
        assert_eq!(recorded2, None);
    }

    #[test]
    fn unpaced_attach_ready_pins_the_exact_wire_keys_for_both_negotiation_sides() {
        // Compatibility invariant (load-bearing): a connection that did NOT
        // negotiate sees a ready frame byte-identical to the pre-contract
        // shape — `oldestRetainedSeq` is ABSENT from the wire (not null), and
        // `replayResetReason` is still absent. The negotiated side adds
        // exactly one key: `oldestRetainedSeq`.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "one\r\n", "S"));

        let (plain_sink, plain_seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            plain_sink,
            Some("plain".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let plain_ready = attach_ready(&plain_seen).expect("attach.ready sent");
        assert_eq!(plain_ready.oldest_retained_seq, None);
        let json = serde_json::to_value(ServerMessage::TerminalAttachReady(plain_ready)).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "attachRequestId",
                "effectiveSinceSeq",
                "geometryAuthority",
                "geometryEpoch",
                "headSeq",
                "replayFromSeq",
                "replayToSeq",
                "requestedSinceSeq",
                "streamId",
                "terminalId",
                "type",
            ],
            "the non-negotiated ready frame keeps the pre-contract key set: {json}"
        );

        let (paced_sink, paced_seen) = collector();
        let _ = reg.attach(
            "T",
            2,
            paced_sink,
            Some("paced".into()),
            0,
            false,
            true,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let paced_ready = attach_ready(&paced_seen).expect("attach.ready sent");
        assert_eq!(paced_ready.oldest_retained_seq, Some(1));
        let json = serde_json::to_value(ServerMessage::TerminalAttachReady(paced_ready)).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "attachRequestId",
                "effectiveSinceSeq",
                "geometryAuthority",
                "geometryEpoch",
                "headSeq",
                "oldestRetainedSeq",
                "replayFromSeq",
                "replayToSeq",
                "requestedSinceSeq",
                "streamId",
                "terminalId",
                "type",
            ],
            "the negotiated ready frame adds exactly oldestRetainedSeq: {json}"
        );
    }

    #[test]
    fn detach_keeps_terminal_running_and_buffering_then_replays_on_reattach() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");

        let (sink_a, seen_a) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink_a,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        reg.feed("T", frame(1, "before\r\n", "S"));
        assert_eq!(outputs(&seen_a).len(), 1);

        // Detach: subscription gone, but the terminal keeps running + buffering.
        reg.detach("T", 1);
        assert!(
            reg.is_running("T"),
            "terminal survives detach (background session)"
        );
        reg.feed("T", frame(2, "while-detached\r\n", "S"));
        // The detached connection receives nothing more.
        assert_eq!(outputs(&seen_a).len(), 1);

        // A fresh attach replays the FULL scrollback (both frames).
        let (sink_b, seen_b) = collector();
        let _ = reg.attach(
            "T",
            2,
            sink_b,
            Some("b".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let replayed = outputs(&seen_b);
        assert_eq!(
            replayed.iter().map(|f| f.data.as_str()).collect::<Vec<_>>(),
            vec!["before\r\n", "while-detached\r\n"]
        );
    }

    #[test]
    fn two_attached_sockets_both_get_live_output_each_with_its_own_attach_id() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");

        let (sink_a, seen_a) = collector();
        let (sink_b, seen_b) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink_a,
            Some("aaa".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        // Second attach: geometry authority flips to multi_client_unknown.
        let _ = reg.attach(
            "T",
            2,
            sink_b,
            Some("bbb".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let ready_b = attach_ready(&seen_b).unwrap();
        assert_eq!(
            ready_b.geometry_authority,
            Some(GeometryAuthority::MultiClientUnknown)
        );

        // One live frame fans out to BOTH sockets, each stamped with its own id.
        reg.feed("T", frame(1, "shared\r\n", "S"));
        let a = outputs(&seen_a);
        let b = outputs(&seen_b);
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].data, "shared\r\n");
        assert_eq!(b[0].data, "shared\r\n");
        assert_eq!(a[0].attach_request_id.as_deref(), Some("aaa"));
        assert_eq!(b[0].attach_request_id.as_deref(), Some("bbb"));
    }

    #[test]
    fn reconnect_catches_up_by_seq_only_replaying_newer_frames() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink_a, seen_a) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink_a,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        for i in 1..=5 {
            reg.feed("T", frame(i, &format!("line-{i}\r\n"), "S"));
        }
        assert_eq!(outputs(&seen_a).len(), 5);

        // Reconnect: the client already rendered through seq 3, so it re-attaches
        // with sinceSeq=3. Only frames 4 and 5 are replayed (seqStart > 3).
        reg.detach("T", 1);
        let (sink_r, seen_r) = collector();
        let _ = reg.attach(
            "T",
            2,
            sink_r,
            Some("a2".into()),
            3,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let ready = attach_ready(&seen_r).unwrap();
        assert_eq!(ready.effective_since_seq, Some(3));
        assert_eq!(ready.replay_from_seq, 4);
        assert_eq!(ready.replay_to_seq, 5);
        let replayed = outputs(&seen_r);
        assert_eq!(
            replayed.iter().map(|f| f.data.as_str()).collect::<Vec<_>>(),
            vec!["line-4\r\n", "line-5\r\n"]
        );
    }

    #[test]
    fn attach_after_reconnect_streams_new_live_output_in_order_after_replay() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "old\r\n", "S"));

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            7,
            sink,
            Some("z".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        // A live frame produced AFTER attach must arrive after the replayed one.
        reg.feed("T", frame(2, "new\r\n", "S"));

        let frames = outputs(&seen);
        assert_eq!(
            frames.iter().map(|f| f.data.as_str()).collect::<Vec<_>>(),
            vec!["old\r\n", "new\r\n"]
        );
        // The live frame keeps source:'live'; the replayed one is 'replay'.
        assert_eq!(frames[0].source, Some(OutputSource::Replay));
        assert_eq!(frames[1].source, Some(OutputSource::Live));
        // Both stamped with the connection's attach id.
        assert!(frames
            .iter()
            .all(|f| f.attach_request_id.as_deref() == Some("z")));
    }

    #[test]
    fn attach_to_unknown_terminal_reports_not_found() {
        let reg = TerminalRegistry::new();
        let (sink, seen) = collector();
        let out = reg.attach(
            "nope",
            1,
            sink,
            None,
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(!out.found);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn input_to_unknown_terminal_reports_not_found() {
        // Silent-loss fix (kata dtfn): the None branch used to be a pure no-op.
        let reg = TerminalRegistry::new();
        let out = reg.input("nope", b"lost bytes");
        assert!(!out.found);
    }

    #[test]
    fn input_to_headless_terminal_reports_found() {
        // Headless => no PTY write, but the terminal EXISTS: found must be true
        // (the activity bump in input_write_resets_the_idle_reap_clock depends
        // on headless input still counting).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.input("T", b"ls\n");
        assert!(out.found);
    }

    #[test]
    fn kill_removes_terminal_notifies_subscribers_and_bumps_revision() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let rev_before = reg.revision();
        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );

        assert!(reg.kill("T"));
        assert!(!reg.is_running("T"), "killed terminal is removed");
        assert!(reg.revision() > rev_before, "revision bumped");

        // The attached connection received terminal.exit.
        let got_exit = seen
            .lock()
            .unwrap()
            .iter()
            .any(|m| matches!(m, ServerMessage::TerminalExit(_)));
        assert!(got_exit);
        // Killing an unknown terminal is a no-op false.
        assert!(!reg.kill("T"));
    }

    #[test]
    fn kill_all_reaps_every_running_terminal_and_notifies_subscribers() {
        // SAFE-11/TERM-22: the shutdown path must reap EVERY tracked terminal
        // (not just the one a caller happens to name), mirroring
        // `terminal-registry.ts:4843` `shutdownGracefully()` applied to the
        // whole registry instead of one id at a time.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-a", "S1");
        reg.insert_headless("T-b", "S2");
        let (sink_a, seen_a) = collector();
        let (sink_b, seen_b) = collector();
        let _ = reg.attach(
            "T-a",
            1,
            sink_a,
            None,
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let _ = reg.attach(
            "T-b",
            2,
            sink_b,
            None,
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let rev_before = reg.revision();

        let killed = reg.kill_all();

        assert_eq!(killed, 2, "both tracked terminals were reaped");
        assert!(!reg.is_running("T-a"));
        assert!(!reg.is_running("T-b"));
        assert!(reg.revision() > rev_before, "revision bumped");
        for seen in [&seen_a, &seen_b] {
            let got_exit = seen
                .lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalExit(_)));
            assert!(got_exit, "each attached subscriber saw terminal.exit");
        }
        // Idempotent / empty-registry-safe: a second call finds nothing left to kill.
        assert_eq!(reg.kill_all(), 0);
    }

    /// SAFE-11/TERM-22 stale-pid group-kill hardening (reviewer "Important"
    /// finding on `edf1e93d`): a terminal that exits NATURALLY is RETAINED in
    /// the registry (`finish_pty_exit` never removes the record -- see its
    /// doc comment), so a LATER, unrelated `kill_all()` sweep (e.g. server
    /// shutdown) still walks it. Its `PtyTerminal`'s cached OS pid may, by
    /// the time that sweep runs, have been recycled by the kernel to a
    /// completely unrelated process (and process group) leader.
    /// `kill_all`/`kill` must never re-attempt the group-kill signal
    /// (`libc::kill(-pid, SIGKILL)`) against a terminal the registry doesn't
    /// believe is still Running -- proven here via the pty.rs test-only
    /// signal-recording seam, not just by checking the terminal "looks" dead.
    #[test]
    fn kill_all_never_group_signals_a_terminal_that_already_exited_naturally() {
        let reg = TerminalRegistry::new();
        let reg_for_exit = reg.clone();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 0".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        let terminal_id = "T-natural-exit".to_string();
        let on_exit_id = terminal_id.clone();
        reg.create(
            &spec,
            &env,
            terminal_id.clone(),
            "S".to_string(),
            "shell",
            None,
            None,
            None,
            Some(Box::new(move |code| {
                // Mirrors the production wiring (`freshell-ws`'s on_exit hook):
                // the reader thread calls `finish_pty_exit` on natural exit.
                reg_for_exit.finish_pty_exit(&on_exit_id, code);
            })),
        )
        .expect("spawn /bin/sh -c 'exit 0'");

        // Wait for the natural exit to be observed (bounded poll; the child
        // exits near-instantly, so this deadline is generous headroom, not a
        // real-time dependency). NOTE: `is_running` only checks the record's
        // presence in the map -- a naturally-exited terminal is RETAINED
        // (still present), so it never goes false here; the actual signal is
        // the record's `status` flipping to `Exited` (`finish_pty_exit`).
        let exited = |reg: &TerminalRegistry| {
            reg.inventory()
                .iter()
                .any(|t| t.terminal_id == terminal_id && t.status == TerminalRunStatus::Exited)
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !exited(&reg) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            exited(&reg),
            "the spawned child must exit naturally within the deadline"
        );

        // Discard anything recorded incidentally before the operation under test.
        let _ = crate::pty::take_group_kill_log();

        let killed = reg.kill_all();
        assert_eq!(killed, 1, "the retained-exited terminal is still reaped");

        assert!(
            crate::pty::take_group_kill_log().is_empty(),
            "kill_all must NOT attempt a group-kill signal against a terminal \
             that already exited naturally -- its cached pid may have been \
             recycled to an unrelated process group"
        );
    }

    /// `is_pty_running` must report run-status, not record presence: a
    /// naturally-exited terminal is RETAINED in the registry (for restore),
    /// so `exists()` stays true while `is_pty_running()` goes false. This is
    /// the distinction create-dedupe eviction anchors to (legacy parity with
    /// the Node server's delete-at-exit requestId pruning).
    #[test]
    fn is_pty_running_false_for_exited_retained_terminal() {
        let reg = TerminalRegistry::new();
        let reg_for_exit = reg.clone();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 0".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        let terminal_id = "T-pty-running-natural-exit".to_string();
        let on_exit_id = terminal_id.clone();
        reg.create(
            &spec,
            &env,
            terminal_id.clone(),
            "S".to_string(),
            "shell",
            None,
            None,
            None,
            Some(Box::new(move |code| {
                // Mirrors the production wiring (`freshell-ws`'s on_exit hook):
                // the reader thread calls `finish_pty_exit` on natural exit.
                reg_for_exit.finish_pty_exit(&on_exit_id, code);
            })),
        )
        .expect("spawn /bin/sh -c 'exit 0'");

        // Wait for the natural exit to be observed (bounded poll; the child
        // exits near-instantly, so this deadline is generous headroom, not a
        // real-time dependency).
        let exited = |reg: &TerminalRegistry| {
            reg.inventory()
                .iter()
                .any(|t| t.terminal_id == terminal_id && t.status == TerminalRunStatus::Exited)
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !exited(&reg) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            exited(&reg),
            "the spawned child must exit naturally within the deadline"
        );

        assert!(
            reg.exists(&terminal_id),
            "exited terminal record is retained for restore"
        );
        assert!(
            !reg.is_pty_running(&terminal_id),
            "is_pty_running must go false at natural exit even though the record is retained"
        );
    }

    /// Positive control for the test above: a terminal that IS still Running
    /// when `kill()` is called must still be group-signaled (the SAFE-11 fix
    /// from `edf1e93d` this hardening must not silently disable).
    #[test]
    fn kill_group_signals_a_still_running_terminal() {
        let reg = TerminalRegistry::new();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        let terminal_id = "T-running".to_string();
        reg.create(
            &spec,
            &env,
            terminal_id.clone(),
            "S".to_string(),
            "shell",
            None,
            None,
            None,
            None,
        )
        .expect("spawn /bin/sh -c 'sleep 30'");
        assert!(reg.is_running(&terminal_id));

        let _ = crate::pty::take_group_kill_log();
        assert!(reg.kill(&terminal_id));

        assert_eq!(
            crate::pty::take_group_kill_log().len(),
            1,
            "kill() on a still-Running terminal must group-signal its PTY exactly once"
        );
    }

    #[test]
    fn inventory_lists_running_terminals_sorted_and_reflects_revision() {
        let reg = TerminalRegistry::new();
        assert!(reg.inventory().is_empty());
        // Pin both terminals to the SAME created_at instead of relying on two
        // back-to-back now_ms() calls happening to land in the same millisecond:
        // under parallel/loaded test execution the wall clock can tick between
        // the two inserts, which would make this a real (not tied) createdAt
        // ordering and flake the fixed expectation below. Forcing an exact tie
        // here is what actually exercises the tie-break this test documents.
        reg.insert_headless_at("T-b", "S1", 1_000);
        reg.insert_headless_at("T-a", "S2", 1_000);
        let inv = reg.inventory();
        assert_eq!(inv.len(), 2);
        for t in &inv {
            assert_eq!(t.status, TerminalRunStatus::Running);
            assert_eq!(t.mode, "shell");
        }
        // created_at ties broken by terminalId → deterministic order. Necessary
        // because (unlike the legacy JS Map, whose iteration preserves insertion
        // order) Rust's HashMap iteration order is arbitrary, so without a total
        // tiebreak a same-timestamp tie would sort non-deterministically per run.
        assert_eq!(inv[0].terminal_id, "T-a");
        assert_eq!(inv[1].terminal_id, "T-b");

        reg.kill("T-a");
        let inv2 = reg.inventory();
        assert_eq!(inv2.len(), 1);
        assert_eq!(inv2[0].terminal_id, "T-b");
    }

    #[test]
    fn set_meta_flows_into_inventory_and_directory_defaults_stay_shell() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");

        // Defaults preserve the pre-meta behavior (getModeLabel('shell') === 'Shell').
        let inv = reg.inventory();
        assert_eq!(inv[0].title, "Shell");
        assert_eq!(inv[0].mode, "shell");
        assert_eq!(inv[0].description, None);
        let dir = reg.directory();
        assert_eq!(dir[0].title, "Shell");
        assert_eq!(dir[0].mode, "shell");
        assert_eq!(dir[0].resume_session_id, None);
        assert!(!dir[0].has_clients);

        // set_meta (the WS create handler's mode context) overrides all fields.
        reg.set_meta(
            "T",
            Some("Claude".into()),
            Some("resumed pane".into()),
            Some("claude".into()),
            Some("sess-1".into()),
        );
        let inv = reg.inventory();
        assert_eq!(inv[0].title, "Claude");
        assert_eq!(inv[0].mode, "claude");
        assert_eq!(inv[0].description.as_deref(), Some("resumed pane"));
        let dir = reg.directory();
        assert_eq!(dir[0].mode, "claude");
        assert_eq!(dir[0].resume_session_id.as_deref(), Some("sess-1"));

        // None leaves fields unchanged (updateTitle only touches the title).
        reg.update_title("T", "Renamed");
        let dir = reg.directory();
        assert_eq!(dir[0].title, "Renamed");
        assert_eq!(dir[0].mode, "claude");
        reg.update_description("T", "new desc");
        assert_eq!(reg.directory()[0].description.as_deref(), Some("new desc"));
    }

    #[test]
    fn directory_reassembles_snapshot_and_reports_clients() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "hello ", "S"));
        reg.feed("T", frame(2, "world\r\n", "S"));
        let dir = reg.directory();
        assert_eq!(dir[0].snapshot, "hello world\r\n");
        assert_eq!(dir[0].status, TerminalRunStatus::Running);
        assert!(!dir[0].has_clients);

        let (sink, _seen) = collector();
        let _ = reg.attach(
            "T",
            9,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(reg.directory()[0].has_clients);
        reg.detach("T", 9);
        assert!(!reg.directory()[0].has_clients);
    }

    #[test]
    fn resize_updates_geometry_epoch_only_on_change() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        reg.resize("T", 100, 40); // first record: applied, no bump
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        reg.resize("T", 100, 40); // identical dims: no bump
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        reg.resize("T", 90, 35); // subsequent real change: bump
        assert_eq!(reg.geometry("T"), Some((90, 35, 2)));
    }

    #[test]
    fn resize_floors_dimensions_at_two_node_broker_parity() {
        // Node: recordTerminalGeometry floors both dims at 2 (broker.ts:672-673).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.resize("T", 0, 0); // first record: floored to (2,2), no epoch bump
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        reg.resize("T", 1, 1); // floors to (2,2): unchanged, no bump
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        reg.resize("T", 1, 40); // floors to (2,40): real change, bump
        assert_eq!(reg.geometry("T"), Some((2, 40, 2)));
        reg.resize("T", 2, 2); // exact minimum passes through unaltered
        assert_eq!(reg.geometry("T"), Some((2, 2, 3)));
        reg.resize("T", 95, 41); // normal values pass through unaltered
        assert_eq!(reg.geometry("T"), Some((95, 41, 4)));
    }

    #[test]
    fn resize_for_attach_floors_dimensions_at_two_node_broker_parity() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let status = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 0, 1);
        assert!(matches!(status, AttachResizeStatus::Resized));
        assert_eq!(reg.geometry("T"), Some((2, 2, 1))); // first record: no bump
        let status = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 1, 2);
        assert!(matches!(status, AttachResizeStatus::Unchanged)); // floored dup
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        let status = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert!(matches!(status, AttachResizeStatus::Resized));
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn first_client_geometry_records_without_epoch_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // 120x30, epoch 1, no client geometry yet
                                       // First client-supplied geometry: applied + recorded, NO epoch bump
                                       // (Node recordTerminalGeometry: hasPreviousGeometry=false => no bump,
                                       // broker.ts:666-686; spawn dims never count, broker.ts:692-697).
        reg.resize("T", 100, 40);
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        // Second real change: bumps.
        reg.resize("T", 90, 35);
        assert_eq!(reg.geometry("T"), Some((90, 35, 2)));
    }

    #[test]
    fn unchanged_first_geometry_still_counts_as_recorded() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Node records geometry on 'unchanged' results too (ws-handler.ts:2995
        // records for both 'resized' and 'unchanged'), so the NEXT change bumps.
        reg.resize("T", 120, 30); // dims equal the spawn default: records, no change
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        reg.resize("T", 95, 41);
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn geometry_reports_cols_rows_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // headless default: 120x30, epoch 1
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));

        assert_eq!(reg.geometry("nope"), None);
    }

    #[test]
    fn resize_for_attach_viewport_hydrate_applies_first_geometry_without_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // 120x30, epoch 1
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        // First-ever client geometry: applied, epoch NOT bumped (Node
        // first-record-no-bump, broker.ts:666-686).
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn simultaneous_first_geometry_attaches_have_one_claimant() {
        use std::sync::Barrier;

        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let start = Arc::new(Barrier::new(3));

        let attach_a = {
            let reg = reg.clone();
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                let (sink, _seen) = collector();
                start.wait();
                reg.attach_with_geometry(
                    "T",
                    1,
                    sink,
                    Some("a-1".into()),
                    0,
                    false,
                    false,
                    None,
                    None,
                    // TERM-07 seam: the geometry-authorized path threads the
                    // client's replay-budget request just like the plain
                    // path (pinned by the subscriber-recording assert below).
                    Some(256 * 1024),
                    TerminalAttachIntent::ViewportHydrate,
                    131,
                    48,
                    PacedAttachOptions::default(),
                )
            })
        };
        let attach_b = {
            let reg = reg.clone();
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                let (sink, _seen) = collector();
                start.wait();
                reg.attach_with_geometry(
                    "T",
                    2,
                    sink,
                    Some("b-1".into()),
                    0,
                    false,
                    false,
                    None,
                    None,
                    None,
                    TerminalAttachIntent::TransportReconnect,
                    67,
                    30,
                    PacedAttachOptions::default(),
                )
            })
        };

        start.wait();
        let a = attach_a.join().expect("first attach thread");
        let b = attach_b.join().expect("second attach thread");

        assert!(a.found && b.found, "both simultaneous viewers must attach");
        assert_eq!(
            [a.geometry, b.geometry]
                .into_iter()
                .filter(|status| matches!(status, Some(AttachResizeStatus::Resized)))
                .count(),
            1,
            "exactly one first attach may claim shared PTY geometry"
        );
        let geometry = reg.geometry("T").expect("terminal geometry");
        assert_eq!(
            geometry.2, 1,
            "the first client geometry record must not bump the epoch"
        );
        assert!(
            matches!(geometry, (131, 48, 1) | (67, 30, 1)),
            "the final dimensions must belong to the one successful first claim: {geometry:?}"
        );
        // TERM-07 seam on the GEOMETRY-AUTHORIZED path (attach_with_geometry
        // threads max_replay_bytes into the same attach_to_shared as the
        // plain path): each subscriber records its own attach's value —
        // a's request verbatim, b's absence as None — with no
        // delivery-behavior change.
        let (recorded_a, recorded_b) = {
            let inner = reg.inner.lock().unwrap();
            let handle = inner.terminals.get("T").unwrap();
            let s = handle.shared.lock().unwrap();
            (
                s.subscribers
                    .get(&1)
                    .expect("conn 1 subscriber")
                    .max_replay_bytes,
                s.subscribers
                    .get(&2)
                    .expect("conn 2 subscriber")
                    .max_replay_bytes,
            )
        };
        assert_eq!(recorded_a, Some(256 * 1024));
        assert_eq!(
            recorded_b, None,
            "an attach without maxReplayBytes records absence"
        );
    }

    #[test]
    fn resize_for_attach_viewport_hydrate_keeps_secondary_viewers_geometry_neutral() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");

        // The first viewer establishes the shared PTY geometry before its
        // subscriber record exists.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 131, 48);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((131, 48, 1)));
        let (sink_a, _seen_a) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink_a,
            Some("a-1".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );

        // A secondary viewer must be able to attach without silently taking
        // over the shared terminal's geometry.
        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::ViewportHydrate, 67, 30);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((131, 48, 1)));
        let (sink_b, _seen_b) = collector();
        let _ = reg.attach(
            "T",
            2,
            sink_b,
            Some("b-1".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );

        // Later attach generations from that same second socket are still
        // replay operations, not implicit geometry transfers.
        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::ViewportHydrate, 67, 30);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((131, 48, 1)));
    }

    #[test]
    fn resize_for_attach_second_change_bumps_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 100, 50);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((100, 50, 2)));
    }

    #[test]
    fn resize_for_attach_unchanged_geometry_records_but_does_not_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 120, 30);
        assert_eq!(out, AttachResizeStatus::Unchanged);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        // Node records geometry on 'unchanged' results too (broker.ts:387-392),
        // so the next real change must bump.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn resize_for_attach_keepalive_delta_never_resizes_or_records() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::KeepaliveDelta, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        // A skipped attach must NOT count as a geometry record (Node's forced
        // 'unchanged' at broker.ts:373 never records): the next applied
        // geometry is still the FIRST record, so no bump.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_applies_when_alone() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // No subscribers at all -> no other attached sockets -> resize.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_skips_when_other_socket_attached() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        ); // conn 1 is attached
           // conn 2 reconnects with another socket attached and no prior attachment of its own.
        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_keeps_repeated_and_fresh_secondary_attaches_neutral() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink_a, _seen_a) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink_a,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );

        // The first transport reconnect from B is replay-only while A views
        // the terminal. Register B so its second generation exercises the
        // same-socket lifecycle path.
        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        let (sink_b, _seen_b) = collector();
        let _ = reg.attach(
            "T",
            2,
            sink_b,
            Some("b".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );

        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));

        // A fresh secondary socket is equally replay-only while A remains.
        let out = reg.resize_for_attach("T", 3, TerminalAttachIntent::TransportReconnect, 100, 50);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }

    #[test]
    fn resize_for_attach_missing_terminal() {
        let reg = TerminalRegistry::new();
        let out = reg.resize_for_attach("nope", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Missing);
    }

    #[test]
    fn resize_for_attach_exited_terminal_not_running() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // finish_pty_exit flips a headless terminal to Exited while RETAINING
        // the record (registry.rs:1112) -- the same seam the existing test
        // attach_to_already_exited_terminal_delivers_synthetic_exit uses.
        assert!(reg.finish_pty_exit("T", 7));
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::NotRunning);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }

    #[test]
    fn remove_connection_sweeps_subscriptions_from_all_terminals() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T1", "S1");
        reg.insert_headless("T2", "S2");
        let (sink1, seen1) = collector();
        let (sink2, seen2) = collector();
        let _ = reg.attach(
            "T1",
            42,
            sink1,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let _ = reg.attach(
            "T2",
            42,
            sink2,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );

        reg.remove_connection(42);
        // Both terminals survive; the swept connection receives no further output.
        assert!(reg.is_running("T1") && reg.is_running("T2"));
        reg.feed("T1", frame(1, "x\r\n", "S1"));
        reg.feed("T2", frame(1, "y\r\n", "S2"));
        assert!(outputs(&seen1).is_empty());
        assert!(outputs(&seen2).is_empty());
    }
    /// Reproduces DEFECT 5b: a terminal that exits (e.g. an instant-exit CLI
    /// failure) BEFORE any client attaches never gets its `terminal.exit`
    /// delivered (finish_pty_exit fanned out to zero subscribers). A client
    /// that attaches afterward currently gets replayed output only -- no
    /// signal the process is dead -- which renders as a permanently blank/
    /// frozen pane. Legacy-parity fix: attach() must synthesize `terminal.exit`
    /// for a terminal that is already `Exited` by the time of attach.
    #[test]
    fn attach_to_already_exited_terminal_delivers_synthetic_exit() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Simulate the race: the PTY exits with a nonzero code before any
        // client ever attaches (finish_pty_exit fans out to zero subscribers).
        assert!(reg.finish_pty_exit("T", 7));

        let (sink, seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);

        let exit = seen.lock().unwrap().iter().find_map(|m| match m {
            ServerMessage::TerminalExit(e) => Some(e.clone()),
            _ => None,
        });
        let exit = exit.expect("attach to an already-exited terminal must deliver terminal.exit");
        assert_eq!(exit.exit_code, 7);
        assert_eq!(exit.terminal_id, "T");
    }

    // ── terminal.modes.sync (mode replay-sync) ─────────────────────────
    //
    // On a `surfaceReset: true` attach (the client's positive "my xterm
    // surface is fresh" marker) the server emits ONE control-plane
    // `terminal.modes.sync` — the mode tracker synthesis of the terminal's
    // retained output stream — strictly after `terminal.attach.ready` and
    // before any replay/live output on that socket (direct channel; the
    // per-terminal lock held here is the same one the output reader takes,
    // so ordering is by construction). Gating: flag Some(true) AND an
    // attachRequestId AND non-empty synthesis.

    fn modes_syncs(seen: &Arc<StdMutex<Vec<ServerMessage>>>) -> Vec<TerminalModesSync> {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalModesSync(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn surface_reset_attach_emits_modes_sync_between_ready_and_replay() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // The app arms mouse + alt screen once at startup (the f01 shape),
        // then writes ordinary output that becomes the replayed scrollback.
        reg.feed("T", frame(1, "\u{1b}[?1003h\u{1b}[?1049h", "S"));
        reg.feed("T", frame(2, "app banner\r\n", "S"));

        let (sink, seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("att-1".into()),
            0,
            false,
            false,
            None,
            Some(true),
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);

        let msgs = seen.lock().unwrap().clone();
        assert!(
            matches!(msgs[0], ServerMessage::TerminalAttachReady(_)),
            "attach.ready is first: {msgs:?}"
        );
        let ServerMessage::TerminalModesSync(sync) = &msgs[1] else {
            panic!("modes.sync must immediately follow attach.ready: {msgs:?}")
        };
        assert_eq!(sync.terminal_id, "T");
        assert_eq!(sync.attach_request_id, "att-1");
        assert_eq!(sync.stream_id, "S");
        assert_eq!(sync.data, "\u{1b}[?1003h\u{1b}[?1049h");
        // Required order: sync strictly BEFORE every replayed output frame.
        assert!(
            msgs.len() > 2
                && msgs[2..]
                    .iter()
                    .all(|m| matches!(m, ServerMessage::TerminalOutput(_))),
            "replayed scrollback follows the sync frame: {msgs:?}"
        );
        assert_eq!(
            modes_syncs(&seen).len(),
            1,
            "exactly one sync frame per attach"
        );
    }

    /// The invariant is identical on the batch-capable attach path: sync
    /// precedes the first `terminal.output.batch`.
    #[test]
    fn surface_reset_attach_emits_sync_before_replay_in_batch_mode() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "\u{1b}[?2004h", "S"));
        reg.feed("T", frame(2, "banner\r\n", "S"));

        let (sink, seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("b1".into()),
            0,
            true,
            false,
            None,
            Some(true),
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);

        let msgs = seen.lock().unwrap().clone();
        let sync_pos = msgs
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalModesSync(_)))
            .expect("sync emitted");
        let first_batch_pos = msgs
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalOutputBatch(_)))
            .expect("batch replay emitted");
        let ready_pos = msgs
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalAttachReady(_)))
            .expect("ready emitted");
        assert!(
            ready_pos < sync_pos && sync_pos < first_batch_pos,
            "ready < sync < batch replay: ready={ready_pos} sync={sync_pos} batch={first_batch_pos}"
        );
    }

    #[test]
    fn attach_without_the_surface_reset_marker_never_emits_modes_sync() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "\u{1b}[?1003h", "S"));

        // Flag absent (None) …
        let (sink_a, seen_a) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink_a,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        // … and explicitly false: no sync either way (fixture f14's gating).
        let (sink_b, seen_b) = collector();
        let _ = reg.attach(
            "T",
            2,
            sink_b,
            Some("b".into()),
            0,
            false,
            false,
            None,
            Some(false),
            None,
            PacedAttachOptions::default(),
        );

        assert!(modes_syncs(&seen_a).is_empty(), "flag absent => no sync");
        assert!(modes_syncs(&seen_b).is_empty(), "flag false => no sync");
    }

    #[test]
    fn surface_reset_with_nothing_to_synthesize_emits_no_sync() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Plain text only: the tracker synthesis is empty (fixture f15's
        // shape), and empty data must never produce a frame.
        reg.feed("T", frame(1, "just plain text\r\n", "S"));

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            Some(true),
            None,
            PacedAttachOptions::default(),
        );
        assert!(modes_syncs(&seen).is_empty(), "empty synthesis => no sync");
    }

    #[test]
    fn surface_reset_without_attach_request_id_emits_no_sync() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "\u{1b}[?1003h", "S"));

        // The client fails closed on a sync lacking attachRequestId
        // (`missing_attach_request_id`), so the server never builds one.
        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            None,
            0,
            false,
            false,
            None,
            Some(true),
            None,
            PacedAttachOptions::default(),
        );
        assert!(
            modes_syncs(&seen).is_empty(),
            "no attachRequestId => no sync"
        );
    }

    /// The Exited-row attach path also emits the sync: a frozen tail still
    /// needs its modes for faithful rendering. The client tolerates
    /// sync-immediately-followed-by-exit (accepted residual in the plan).
    #[test]
    fn surface_reset_attach_to_exited_terminal_emits_sync_then_exit() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "\u{1b}[?1006h", "S"));
        assert!(reg.finish_pty_exit("T", 3));

        let (sink, seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            Some(true),
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);

        let msgs = seen.lock().unwrap().clone();
        let ready_pos = msgs
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalAttachReady(_)))
            .expect("ready emitted");
        let sync_pos = msgs
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalModesSync(_)))
            .expect("sync emitted for the exited attach too");
        let exit_pos = msgs
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalExit(_)))
            .expect("synthetic exit delivered");
        assert!(
            ready_pos < sync_pos && sync_pos < exit_pos,
            "ready < sync < exit: ready={ready_pos} sync={sync_pos} exit={exit_pos}"
        );
        let syncs = modes_syncs(&seen);
        assert_eq!(syncs.len(), 1);
        assert_eq!(syncs[0].data, "\u{1b}[?1006h");
    }

    // `enforce_idle_kills` (TERM-11, `autoKillIdleMinutes`): legacy parity port
    // of `enforceIdleKills` (`terminal-registry.ts:1406-1425`). Each test backdates
    // `lastActivityAt` directly instead of sleeping for real minutes.

    #[test]
    fn new_registry_defaults_auto_kill_idle_minutes_to_legacy_default() {
        // `server/settings.ts:791` `autoKillIdleMinutes: 15` -- the Rust default
        // (`crates/freshell-server/src/settings.rs:70`) must match so a boot that
        // never calls `set_auto_kill_idle_minutes` (e.g. a settings load failure)
        // still behaves like the documented default, not "disabled".
        let reg = TerminalRegistry::new();
        assert_eq!(reg.auto_kill_idle_minutes(), 15);
    }

    #[test]
    fn enforce_idle_kills_kills_detached_terminal_past_threshold() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(5);
        // 6 minutes idle, 5-minute threshold -> eligible.
        reg.backdate_last_activity("T", now_ms() - 6 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert_eq!(killed, vec!["T".to_string()]);
        assert!(
            reg.inventory().is_empty(),
            "kill() removes the terminal record"
        );
    }

    #[test]
    fn enforce_idle_kills_leaves_terminal_under_threshold_running() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(5);
        // Only 4 minutes idle, 5-minute threshold -> not yet eligible.
        reg.backdate_last_activity("T", now_ms() - 4 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_never_kills_an_attached_terminal() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);
        reg.set_auto_kill_idle_minutes(1);
        // Far past any threshold, but a client is attached -- legacy:
        // `if (term.clients.size > 0) continue // only detached`.
        reg.backdate_last_activity("T", now_ms() - 999 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_reaps_detached_terminal_with_only_repaint_noise() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        // Warm-up: the FIRST paint of a status line is genuinely new content
        // and legitimately counts as activity.
        reg.feed("T", frame(1, "\r\x1b[2K⠋ (1s • esc to interrupt)", "S"));
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        // Codex-style repaint noise after the backdate: same status line,
        // only the braille glyph and the digits tick. Each frame still bumps
        // the wire-visible last_activity_at (unchanged legacy semantics) but
        // must NOT refresh the reap clock.
        for (i, paint) in [
            "\r\x1b[2K⠙ (2s • esc to interrupt)",
            "\r\x1b[2K⠹ (3s • esc to interrupt)",
            "\r\x1b[2K⠸ (14s • esc to interrupt)",
            "\r\x1b[2K⠼ (65s • esc to interrupt)",
        ]
        .iter()
        .enumerate()
        {
            reg.feed("T", frame(i as i64 + 2, paint, "S"));
        }

        let killed = reg.enforce_idle_kills();

        assert_eq!(killed, vec!["T".to_string()]);
        assert!(reg.inventory().is_empty());
    }

    #[test]
    fn enforce_idle_kills_spares_agent_mode_terminals_past_threshold() {
        // ITEM-3 (`terminal.killed by="idle"` forensics): agent CLIs are
        // legitimately PTY-silent far beyond any idle threshold while
        // mid-work (long LLM calls, long tool runs), and their spinner
        // repaints are deliberately noise-classified (DEV-0009). PTY
        // silence is NOT evidence of idleness for these modes — within
        // the 24 h hard cap they must be spared (999 min << 24 h).
        let reg = TerminalRegistry::new();
        reg.set_auto_kill_idle_minutes(5);
        for mode in ["claude", "codex", "opencode", "amplifier", "gemini", "kimi"] {
            let id = format!("T-{mode}");
            reg.register_headless(HeadlessTerminal {
                terminal_id: id.clone(),
                stream_id: format!("S-{mode}"),
                mode: mode.to_string(),
                resume_session_id: None,
                create_request_id: None,
                created_at: Some(now_ms()),
            });
            // 999 minutes stale vs a 5-minute threshold.
            reg.backdate_last_activity(&id, now_ms() - 999 * 60_000);
        }

        let killed = reg.enforce_idle_kills();

        assert!(
            killed.is_empty(),
            "agent-mode terminals with a live child must never be idle-reaped, got {killed:?}"
        );
        assert_eq!(reg.inventory().len(), 6);
    }

    #[test]
    fn enforce_idle_kills_mixed_sweep_reaps_only_the_shell() {
        // The hard cap applies to a CLOSED list: plain shells (and future
        // modes) keep the legacy reap behavior — the sweep still does its
        // resource-cleanup job.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-shell", "S-shell"); // fixture mode: "shell"
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-amp".to_string(),
            stream_id: "S-amp".to_string(),
            mode: "amplifier".to_string(),
            resume_session_id: None,
            create_request_id: None,
            created_at: Some(now_ms()),
        });
        reg.set_auto_kill_idle_minutes(5);
        reg.backdate_last_activity("T-shell", now_ms() - 6 * 60_000);
        reg.backdate_last_activity("T-amp", now_ms() - 6 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert_eq!(killed, vec!["T-shell".to_string()]);
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_reaps_agent_terminals_past_the_hard_cap() {
        // ITEM-3 counterweight (ledger A14): Running is NOT a loss-proof
        // live-child signal (a descendant holding the PTY slave fd wedges
        // exit detection), and this sweep is the only cleanup for wedged
        // rows — so agents are capped, not fully exempt.
        let reg = TerminalRegistry::new();
        reg.set_auto_kill_idle_minutes(5);
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-amp-wedged".to_string(),
            stream_id: "S-amp-wedged".to_string(),
            mode: "amplifier".to_string(),
            resume_session_id: None,
            create_request_id: None,
            created_at: Some(now_ms()),
        });
        // 25 hours stale — past the 24-hour agent hard cap.
        reg.backdate_last_activity("T-amp-wedged", now_ms() - 25 * 60 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert_eq!(killed, vec!["T-amp-wedged".to_string()]);
    }

    #[test]
    fn enforce_idle_kills_spares_detached_terminal_streaming_genuine_output() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        // A long build streaming REAL new log lines: genuine work, must
        // survive the sweep even while detached.
        reg.feed(
            "T",
            frame(1, "   Compiling freshell-terminal v0.1.0\n", "S"),
        );
        reg.feed(
            "T",
            frame(2, "warning: unused variable `x` in registry.rs\n", "S"),
        );

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn input_write_resets_the_idle_reap_clock() {
        // User keystrokes are always activity (headless => the PTY write is
        // skipped but the activity bump still happens, matching input()).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert!(reg.input("T", b"ls\n").found);

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn detach_grants_full_idle_threshold_of_grace() {
        // A user may WATCH a spinner-only terminal attached for hours: the
        // attached exemption forbids reaping, but nothing refreshes the
        // meaningful clock, so it pre-expires underneath them. Detaching
        // must therefore grant one full threshold of grace (DEV-0009) —
        // otherwise the very next 30s sweep kills a terminal the user
        // deliberately backgrounded seconds earlier (legacy never reaped it;
        // terminal-core.md A13: "terminal stays running").
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        reg.detach("T", 1);

        // Freshly detached: the transition bump spares it a full threshold.
        assert!(reg.enforce_idle_kills().is_empty());
        assert_eq!(reg.inventory().len(), 1);

        // Once it goes stale again AFTER the detach, it is reaped normally.
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert_eq!(reg.enforce_idle_kills(), vec!["T".to_string()]);
    }

    #[test]
    fn disconnect_grants_full_idle_threshold_of_grace() {
        // Socket-close cleanup (remove_connection) is the other live
        // transition-to-detached path and must grant the same grace as an
        // explicit detach. The bump is gated on "this connection actually
        // subscribed here AND the set became empty AND status is Running" —
        // remove_connection iterates EVERY terminal, and an unconditional
        // bump would reset unrelated detached terminals' countdowns on
        // every socket close.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);
        // A second, already-detached terminal whose countdown must NOT be
        // disturbed by conn 1's disconnect.
        reg.insert_headless("U", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        reg.backdate_last_activity("U", now_ms() - 10 * 60_000);
        reg.remove_connection(1);

        let killed = reg.enforce_idle_kills();

        // T was freshly detached by the disconnect => spared one threshold.
        // U never had a subscriber => its stale countdown stands => reaped.
        assert_eq!(killed, vec!["U".to_string()]);
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_spares_disconnect_detached_terminal_past_threshold() {
        // The background-session promise (§1.3, "what if tmux and Claude fell
        // in love"): a user who closes the browser / sleeps the laptop with a
        // quiet shell in a pane must find it ALIVE when they come back — the
        // client never sent terminal.detach, so the terminal is detached but
        // still wanted. Before the fix, 20 idle minutes past the default
        // 15-minute autoKillIdleMinutes threshold silently SIGKILLed it
        // (scrollback gone). Now only the 24h hard cap applies.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        assert!(
            reg.attach(
                "T",
                1,
                sink,
                Some("a".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );
        reg.set_auto_kill_idle_minutes(15); // the shipped default
        reg.remove_connection(1); // socket drop, NOT an explicit detach
                                  // 20 minutes idle — past the old ~15-minute threshold, far under 24h.
        reg.backdate_last_activity("T", now_ms() - 20 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(
            killed.is_empty(),
            "a detached-but-wanted terminal (connection lost, never released) \
             must survive past the configured idle threshold, got {killed:?}"
        );
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_reaps_disconnect_detached_terminal_past_the_hard_cap() {
        // Counterweight: the sweep stays the cleanup backstop for sessions
        // whose client never comes back — same 24h hard cap agents get.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        assert!(
            reg.attach(
                "T",
                1,
                sink,
                Some("a".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );
        reg.set_auto_kill_idle_minutes(15);
        reg.remove_connection(1);
        // 25 hours stale — past the 24-hour hard cap.
        reg.backdate_last_activity("T", now_ms() - 25 * 60 * 60_000);

        assert_eq!(reg.enforce_idle_kills(), vec!["T".to_string()]);
    }

    // ── Hidden-pane lifetime claims (responsive-terminal-restore WS1) ──

    /// A claim marks the terminal wanted for a connection WITHOUT attaching:
    /// it clears `released_by_client` under the terminal lock, adds no
    /// subscriber, and delivers no replay (there is no sink to deliver to).
    #[test]
    fn claim_clears_released_by_client_without_attaching() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // A never-attached row starts fast-reap eligible (released == true).
        assert_eq!(
            reg.claim_state("T"),
            Some(ClaimState {
                claimers: 0,
                released_by_client: true
            })
        );

        assert!(reg.claim_terminal("T", 7));

        let state = reg.claim_state("T").expect("terminal exists");
        assert_eq!(state.claimers, 1);
        assert!(
            !state.released_by_client,
            "a claim must clear released_by_client (the terminal is wanted)"
        );
        // No attach happened: the row still has zero subscribers (hasClients
        // stays false) — the claim never granted replay or output delivery.
        assert!(!reg.directory()[0].has_clients);
        // Unknown ids are a no-op (stale client layouts may claim dead rows).
        assert!(!reg.claim_terminal("nope", 7));
    }

    /// Explicit withdrawal of the last claim (no subscribers left) restores
    /// configured-threshold reapability with the same fresh-idle-grace bump
    /// detach uses (DEV-0009): spared immediately, reaped once stale again.
    #[test]
    fn explicit_withdrawal_of_last_claim_restores_threshold_eligibility_with_grace() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.claim_terminal("T", 7);
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);

        reg.withdraw_claim("T", 7);
        let state = reg.claim_state("T").expect("terminal exists");
        assert_eq!(state.claimers, 0);
        assert!(
            state.released_by_client,
            "withdrawal of the last claim must restore fast-reap eligibility"
        );
        // DEV-0009: the withdrawal just happened — one full threshold of
        // grace, so the stale pre-withdrawal clock does not reap immediately.
        assert!(reg.enforce_idle_kills().is_empty());

        // Once stale again AFTER the withdrawal, the configured threshold
        // applies (the claim is gone; this is the explicit release path).
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert_eq!(reg.enforce_idle_kills(), vec!["T".to_string()]);
    }

    /// Claim membership is per-connection and sweeps away with its socket
    /// (`remove_connection`), but transport loss is NOT release: a dropped
    /// claiming connection keeps the terminal wanted (24h hard cap only —
    /// identical to attached-then-disconnected today). A reconnected client
    /// re-claims and the terminal stays wanted.
    #[test]
    fn claim_connection_drop_keeps_terminal_wanted_and_reconnect_reclaims() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.claim_terminal("T", 1);

        reg.remove_connection(1); // transport loss, NOT an explicit release
        let state = reg.claim_state("T").expect("terminal exists");
        assert_eq!(state.claimers, 0);
        assert!(
            !state.released_by_client,
            "a dropped socket must not restore fast-reap eligibility"
        );

        // Past the configured threshold (but far under 24h): still wanted.
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert!(reg.enforce_idle_kills().is_empty());

        // The reconnected client re-claims the hidden terminal (reconnect-
        // hidden re-claims) and it survives again.
        assert!(reg.claim_terminal("T", 2));
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert!(reg.enforce_idle_kills().is_empty());

        // The 24h hard cap stays the cleanup backstop for an abandoned claim.
        reg.remove_connection(2);
        reg.backdate_last_activity("T", now_ms() - 25 * 60 * 60_000);
        assert_eq!(reg.enforce_idle_kills(), vec!["T".to_string()]);
    }

    /// A claimed terminal that is then ATTACHED and whose socket drops stays
    /// wanted — no regression of the attached-then-disconnected contract
    /// (transport loss is not release) when claims coexist with subscriptions.
    #[test]
    fn claimed_then_attached_terminal_survives_socket_drop() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.claim_terminal("T", 2);
        let (sink, _seen) = collector();
        assert!(
            reg.attach(
                "T",
                1,
                sink,
                Some("a".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );

        reg.remove_connection(1); // the ATTACHED connection drops
        let state = reg.claim_state("T").expect("terminal exists");
        assert_eq!(state.claimers, 1, "the claiming connection still holds it");
        assert!(!state.released_by_client);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert!(reg.enforce_idle_kills().is_empty());
    }

    /// Detach reconciler interplay: a claimed+attached terminal leaving every
    /// pane layout is released — but only once BOTH the last subscriber and
    /// the last claim are gone. The claim is the explicit withdrawal path.
    #[test]
    fn detach_releases_only_when_the_last_claim_is_also_gone() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.claim_terminal("T", 1);
        let (sink, _seen) = collector();
        assert!(
            reg.attach(
                "T",
                2,
                sink,
                Some("a".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );

        // The detach reconciler acts (terminal left every pane layout) while
        // the claim is still recorded: still wanted — the other connection's
        // claim keeps it alive.
        reg.detach("T", 2);
        let state = reg.claim_state("T").expect("terminal exists");
        assert_eq!(state.claimers, 1);
        assert!(
            !state.released_by_client,
            "detach must not release a terminal another connection still claims"
        );
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert!(reg.enforce_idle_kills().is_empty());

        // The interest snapshot withdraws the claim (the pane is gone): NOW
        // the terminal is genuinely orphaned and reap-eligible at the
        // threshold, with the DEV-0009 grace bump on the release transition.
        reg.withdraw_claim("T", 1);
        assert!(reg.enforce_idle_kills().is_empty());
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert_eq!(reg.enforce_idle_kills(), vec!["T".to_string()]);
    }

    /// Reaper lifecycle for a created-hidden terminal (never attached,
    /// released starts true): held only by the negotiated claim it survives
    /// the configured threshold; explicit withdrawal (no subscribers) reaps
    /// it at the threshold.
    #[test]
    fn created_hidden_terminal_held_only_by_claim_survives_then_withdrawal_reaps() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);

        // Created-hidden: the client claims it in its interest snapshot
        // instead of attaching.
        assert!(reg.claim_terminal("T", 1));
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert!(
            reg.enforce_idle_kills().is_empty(),
            "a claim-only terminal must survive the configured idle threshold"
        );

        // Explicit withdrawal with no subscribers: back to fast-reap
        // eligibility, reaped at the threshold once past the grace bump.
        reg.withdraw_claim("T", 1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert_eq!(reg.enforce_idle_kills(), vec!["T".to_string()]);
    }

    #[test]
    fn reattach_after_explicit_detach_restores_disconnect_protection() {
        // released_by_client must be a live flag, not a one-way latch:
        // detach (orphaned) -> reattach (wanted again) -> socket drop must
        // land back in the protected detached-but-wanted state.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        assert!(
            reg.attach(
                "T",
                1,
                sink,
                Some("a".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );
        reg.detach("T", 1); // explicitly released — fast-reap eligible
        let (sink2, _seen2) = collector();
        assert!(
            reg.attach(
                "T",
                2,
                sink2,
                Some("b".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );
        reg.set_auto_kill_idle_minutes(15);
        reg.remove_connection(2); // wanted again, then socket drop
        reg.backdate_last_activity("T", now_ms() - 20 * 60_000);

        assert!(reg.enforce_idle_kills().is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_disabled_when_minutes_zero() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(0);
        reg.backdate_last_activity("T", now_ms() - 999 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(
            killed.is_empty(),
            "0 must disable the sweep, matching legacy's `!killMinutes` guard"
        );
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_disabled_when_minutes_negative() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(-1);
        reg.backdate_last_activity("T", now_ms() - 999 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    // `enforce_stuck_detection` (wedge-backstop Task 1): the terminal-mode
    // wedged-agent backstop. Same backdate-driven discipline as the idle-kill
    // suite above, but the wedge differential means a row only flags when
    // the output-only MEANINGFUL clock is stale past the window WHILE the
    // output-only RAW output clock keeps flowing (a pure repaint loop) —
    // keystrokes and teardown grace touch neither output clock, so
    // backdating alone can never flag.

    #[test]
    fn new_registry_defaults_stuck_window_ms_to_the_documented_default() {
        // The 2h default must apply when a boot never calls
        // `set_stuck_window_ms` — mirrors
        // `new_registry_defaults_auto_kill_idle_minutes_to_legacy_default`.
        let reg = TerminalRegistry::new();
        assert_eq!(reg.stuck_window_ms(), DEFAULT_STUCK_WINDOW_MS);
        assert_eq!(DEFAULT_STUCK_WINDOW_MS, 7_200_000);
    }

    const STUCK_TEST_WINDOW_MS: i64 = 100;

    fn stuck_test_registry(mode: &str) -> TerminalRegistry {
        // Agent-mode row construction mirroring
        // `enforce_idle_kills_spares_agent_mode_terminals_past_threshold`.
        let reg = TerminalRegistry::new();
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T".to_string(),
            stream_id: "S".to_string(),
            mode: mode.to_string(),
            resume_session_id: None,
            create_request_id: None,
            created_at: Some(now_ms()),
        });
        reg.set_stuck_window_ms(STUCK_TEST_WINDOW_MS);
        reg
    }

    /// Attach a collector subscriber, mirroring
    /// `enforce_idle_kills_never_kills_an_attached_terminal`'s attach shape.
    fn attach_test_subscriber(reg: &TerminalRegistry) {
        let (sink, _seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);
    }

    /// The shared flag-setup: warm the fingerprint ring with one meaningful
    /// first-occurrence frame, backdate every activity clock past the
    /// window, then feed ring-repeat repaint variants (noise → output-raw
    /// fresh, meaningful stale). This is the ONLY way a row reaches the
    /// flagged state — both the flag test and the clear tests must start
    /// from here (round-3 review Major: backdating alone can never flag,
    /// because the predicate also requires output-activity freshness).
    fn flag_stuck_row(reg: &TerminalRegistry) {
        reg.feed("T", frame(1, "\r\x1b[2K⠋ (1s • esc to interrupt)", "S"));
        reg.backdate_last_activity("T", now_ms() - (STUCK_TEST_WINDOW_MS + 1));
        for (i, glyph) in ["⠙", "⠹", "⠸", "⠼"].iter().enumerate() {
            reg.feed(
                "T",
                frame(
                    2 + i as i64,
                    &format!("\r\x1b[2K{glyph} ({}s • esc to interrupt)", i + 2),
                    "S",
                ),
            );
        }
        let transitions = reg.enforce_stuck_detection();
        assert_eq!(transitions.len(), 1);
        assert!(transitions[0].stuck);
        assert_eq!(transitions[0].terminal_id, "T");
        assert_eq!(transitions[0].mode, "opencode");
        // Idempotent: a second sweep emits no transition.
        assert!(reg.enforce_stuck_detection().is_empty());
    }

    #[test]
    fn stuck_detection_flags_attached_agent_pane_with_only_repaint_noise() {
        let reg = stuck_test_registry("opencode");
        // Attach a subscriber FIRST — the deliberate divergence from the idle
        // reaper: attached panes are the primary target class (the reaper
        // exempts them by design). The flag transition and its shape are
        // asserted by the helper — an ATTACHED row flagging is the whole
        // point of this test.
        attach_test_subscriber(&reg);
        flag_stuck_row(&reg);
    }

    #[test]
    fn stuck_detection_clears_on_meaningful_output() {
        let reg = stuck_test_registry("opencode");
        flag_stuck_row(&reg);
        // Genuinely-new content refreshes the meaningful clock (ingest path).
        reg.feed("T", frame(9, "meaningful new text line\n", "S"));
        let cleared = reg.enforce_stuck_detection();
        assert_eq!(cleared.len(), 1);
        assert!(!cleared[0].stuck);
    }

    /// Episode-3 focused review, Finding 1: the wedge signal is PTY
    /// OUTPUT — the classifier's judgment of the pane's OUTPUT. A user
    /// typing at / Ctrl+C-ing a genuinely wedged pane (the natural first
    /// response) must NOT clear or postpone the stuck state: the process
    /// is still wedged regardless of what the user types. Keystrokes keep
    /// their DEV-0009 meaning for the REAPER clock only (pinned by
    /// `input_write_resets_the_idle_reap_clock`); the wedge clocks (both
    /// output-only) advance exclusively via PTY output — the raw clock
    /// on every frame, the meaningful clock on NoiseScanner-accepted
    /// content (the `stuck_detection_clears_on_meaningful_output` door).
    /// `input` returns `InputOutcome` (NOT a Result — no unwrap).
    #[test]
    fn stuck_detection_survives_user_input() {
        let reg = stuck_test_registry("opencode");
        flag_stuck_row(&reg);
        assert!(reg.input("T", b"x").found);
        // The sweep must emit NO clear transition — the row still matches
        // the wedge predicate (meaningful output stale, activity fresh).
        assert!(
            reg.enforce_stuck_detection().is_empty(),
            "typing at a wedged pane must not un-wedge it"
        );
        // And the flag SURVIVED: a fresh subscriber's attach-time stuck
        // truth still reports stuck:true (the page_refresh test's probe
        // shape).
        let (sink, seen) = collector();
        assert!(
            reg.attach(
                "T",
                1,
                sink,
                Some("att-surv".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );
        let stuck = stuck_frames(&seen);
        assert_eq!(stuck.len(), 1);
        assert!(stuck[0].stuck, "the stuck flag survived the user input");
    }

    /// Episode-3 focused review r2, Finding 1: the wedge differential's
    /// FRESHNESS conjunct must read an OUTPUT-ONLY raw clock. The mixed
    /// `last_activity_at` is refreshed by keystrokes too (`input`), so a
    /// keypress could manufacture the differential on a HEALTHY quiet
    /// pane: both output clocks stale past the window AND the freshness
    /// bound (a pane sitting at a prompt — the
    /// `stuck_detection_ignores_prompt_idle_rows...` shape), user presses
    /// a key → `input` refreshes the mixed raw clock while both output
    /// clocks stay stale → the old predicate saw "meaningful stale +
    /// activity fresh" and FLAGGED a non-wedged pane (violating the
    /// no-alteration contract). The sweep's freshness conjunct reads
    /// `last_output_activity_at` — refreshed ONLY by `ingest` output
    /// frames — so keystrokes can never mint wedge freshness; only a
    /// real output stream (a repaint loop) can.
    #[test]
    fn keypress_does_not_manufacture_wedge_freshness() {
        let reg = stuck_test_registry("opencode");
        // A healthy agent pane sitting quietly at a prompt: EVERY clock —
        // both output clocks included — backdated past the window AND the
        // activity-freshness bound (a genuinely quiet pane, quiet for
        // hours, has no fresh output of any kind).
        reg.backdate_last_activity(
            "T",
            now_ms() - (STUCK_ACTIVITY_FRESH_MS + STUCK_TEST_WINDOW_MS + 1),
        );
        // The user presses a key: `input` refreshes the MIXED clocks
        // (`last_activity_at` + the reaper's `last_meaningful_activity_at`)
        // and neither output clock. `input` returns `InputOutcome` (NOT a
        // Result — no unwrap; assert the write landed).
        assert!(reg.input("T", b"x").found);
        // The sweep must NOT flag: the wedge differential requires FRESH
        // RAW OUTPUT, and no output frame has arrived — keystroke-only
        // freshness cannot manufacture the conjunct.
        assert!(
            reg.enforce_stuck_detection().is_empty(),
            "a keypress must not manufacture wedge freshness on a quiet pane"
        );
    }

    /// Episode-3 r3, Finding 3 (the tiny-window merely-exists false
    /// positive): both output clocks init to the creation time, so with a
    /// configured window BELOW `STUCK_ACTIVITY_FRESH_MS` a row that merely
    /// EXISTS past the window satisfies the old two-conjunct predicate —
    /// its equal clocks are (window+1) old, which is BOTH stale past a
    /// tiny window AND "fresh" under the 5-minute freshness bound — and a
    /// never-wedged pane flags. The fix's strict clock-ordering conjunct
    /// (`last_output_activity_at > last_meaningful_output_at`) separates
    /// the classes: a wedge's repaint stream advances the raw clock
    /// STRICTLY past the frozen meaningful clock, while a merely-quiet
    /// row's output clocks stay EQUAL.
    #[test]
    fn tiny_window_does_not_flag_a_merely_existing_row() {
        let reg = stuck_test_registry("opencode");
        // Precondition: the test window is genuinely below the freshness
        // bound, so the merely-exists shape is reachable at all (read back
        // through the setter, not asserted on the source constants).
        assert!(reg.stuck_window_ms() < STUCK_ACTIVITY_FRESH_MS);
        // A row that has NEVER emitted (no feed — `backdate_last_activity`
        // is the only clock movement, and it stamps every activity clock
        // equally): both output clocks sit at the same backdated instant.
        reg.backdate_last_activity("T", now_ms() - (STUCK_TEST_WINDOW_MS + 1));
        assert!(
            reg.enforce_stuck_detection().is_empty(),
            "a merely-existing row (equal output clocks, no repaint stream) \
             must not flag under a window below the freshness bound"
        );
    }

    #[test]
    fn stuck_detection_ignores_shell_mode_and_exited_rows_and_under_window() {
        // shell-mode row past the window with fresh activity → no transition.
        // agent-mode row under the window → no transition.
        // agent-mode row with status != Running → no transition (the 5320
        // suite's headless exit shape, `finish_pty_exit`).
        // Deterministic boundary (delta-review round 2, Minor): the
        // under-window arm previously relied on the shared 100ms test
        // window with a never-fed row — its age had to stay under 100ms
        // from creation through the sweep, so a scheduler pause flipped
        // it into flag territory (age past the window while still inside
        // the 300s activity-fresh bound). A 60s window with the row
        // backdated to half the window keeps the arm a genuine
        // under-threshold probe (agent-mode + Running + activity-fresh —
        // the window is the ONLY non-qualifying condition).
        const WINDOW_MS: i64 = 60_000;
        // Half the window: the margin IS the scheduler-jitter budget —
        // 30s, three orders beyond any plausible mid-test pause — while
        // the row still probes the under-threshold side of the boundary.
        const UNDER_WINDOW_AGE_MS: i64 = WINDOW_MS / 2;
        let reg = stuck_test_registry("opencode");
        reg.set_stuck_window_ms(WINDOW_MS);
        // `T` (opencode) IS the under-window arm: backdated to half the
        // window — 30s inside the 60s window and well inside the 300s
        // activity-fresh bound, so it must never flag.
        reg.backdate_last_activity("T", now_ms() - UNDER_WINDOW_AGE_MS);

        // Shell-mode row: identical wedge shape, wrong mode.
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-shell".to_string(),
            stream_id: "S-shell".to_string(),
            mode: "shell".to_string(),
            resume_session_id: None,
            create_request_id: None,
            created_at: Some(now_ms()),
        });
        reg.feed(
            "T-shell",
            frame(1, "\r\x1b[2K⠋ (1s • esc to interrupt)", "S-shell"),
        );
        reg.backdate_last_activity("T-shell", now_ms() - (WINDOW_MS + 1));
        reg.feed(
            "T-shell",
            frame(2, "\r\x1b[2K⠙ (2s • esc to interrupt)", "S-shell"),
        );

        // Agent-mode row that WEDGED and then exited: Running is required.
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-exited".to_string(),
            stream_id: "S-exited".to_string(),
            mode: "opencode".to_string(),
            resume_session_id: None,
            create_request_id: None,
            created_at: Some(now_ms()),
        });
        reg.feed(
            "T-exited",
            frame(1, "\r\x1b[2K⠋ (1s • esc to interrupt)", "S-exited"),
        );
        reg.backdate_last_activity("T-exited", now_ms() - (WINDOW_MS + 1));
        reg.feed(
            "T-exited",
            frame(2, "\r\x1b[2K⠙ (2s • esc to interrupt)", "S-exited"),
        );
        assert!(reg.finish_pty_exit("T-exited", 3));

        assert!(
            reg.enforce_stuck_detection().is_empty(),
            "shell-mode, under-window, and exited rows must never transition"
        );
    }

    #[test]
    fn stuck_detection_ignores_prompt_idle_rows_where_both_clocks_are_stale() {
        // The round-1 review pin: a pane sitting quietly at a prompt emits
        // NOTHING — both output clocks age together, so there is no repaint
        // loop and the pane must NOT be flagged (flagging it would alter a
        // non-wedged pane). Backdate EVERY activity clock equally past BOTH
        // bounds (the window AND the activity-freshness bound); do NOT feed.
        let reg = stuck_test_registry("opencode");
        reg.backdate_last_activity(
            "T",
            now_ms() - (STUCK_ACTIVITY_FRESH_MS + STUCK_TEST_WINDOW_MS + 1),
        );
        assert!(reg.enforce_stuck_detection().is_empty());
    }

    #[test]
    fn stuck_detection_clears_when_output_freezes_entirely() {
        // A flagged pane whose repaint stream stops (output activity goes
        // stale) is no longer provably a repaint loop: clear the flag with
        // a transition.
        let reg = stuck_test_registry("opencode");
        flag_stuck_row(&reg);
        // Backdate EVERY activity clock far past the freshness bound, feed
        // nothing (the ring-warm discipline lives in the helper — a bare
        // "⠋ repaint" feed here would carry the significant word "repaint"
        // and refresh the MEANINGFUL clock, breaking the test).
        reg.backdate_last_activity(
            "T",
            now_ms() - (STUCK_ACTIVITY_FRESH_MS + STUCK_TEST_WINDOW_MS + 1),
        );
        let cleared = reg.enforce_stuck_detection();
        assert_eq!(cleared.len(), 1);
        assert!(!cleared[0].stuck);
    }

    /// Delta-review round 3 (log accuracy): a clear has three distinct
    /// causes — the clear log must name the one that ACTUALLY fired instead
    /// of always claiming a meaningful-activity resume. Pinned via the house
    /// `tracing_capture` helper (the DIAG-01 event-field discipline).
    #[test]
    fn stuck_detection_clear_log_names_the_actual_cause_per_arm() {
        let reg = stuck_test_registry("opencode");

        // Cause: genuinely-new output refreshed the meaningful clock while
        // the row still runs.
        flag_stuck_row(&reg);
        reg.feed("T", frame(9, "meaningful new text line\n", "S"));
        let (events, _guard) = tracing_capture::capture();
        let cleared = reg.enforce_stuck_detection();
        drop(_guard);
        assert_eq!(cleared.len(), 1);
        assert!(!cleared[0].stuck);
        assert_stuck_clear_reason(&events, "meaningful-activity-resumed");

        // Cause: the repaint stream froze — raw output went stale, so the
        // pane is no longer provably a repaint loop.
        flag_stuck_row(&reg);
        reg.backdate_last_activity(
            "T",
            now_ms() - (STUCK_ACTIVITY_FRESH_MS + STUCK_TEST_WINDOW_MS + 1),
        );
        let (events, _guard) = tracing_capture::capture();
        let cleared = reg.enforce_stuck_detection();
        drop(_guard);
        assert_eq!(cleared.len(), 1);
        assert!(!cleared[0].stuck);
        assert_stuck_clear_reason(&events, "repaint-output-stopped");

        // Cause: the terminal exited while flagged — status left Running.
        // `finish_pty_exit` ALSO refreshes every activity clock, so this
        // arm proves the not-running cause must take priority over the
        // clock causes.
        flag_stuck_row(&reg);
        assert!(reg.finish_pty_exit("T", 0));
        let (events, _guard) = tracing_capture::capture();
        let cleared = reg.enforce_stuck_detection();
        drop(_guard);
        assert_eq!(cleared.len(), 1);
        assert!(!cleared[0].stuck);
        assert_stuck_clear_reason(&events, "terminal-not-running");
    }

    fn assert_stuck_clear_reason(
        events: &Arc<StdMutex<Vec<tracing_capture::CapturedEvent>>>,
        reason: &str,
    ) {
        let captured = events.lock().unwrap();
        let cleared = captured
            .iter()
            .find(|e| e.fields.get("event").map(String::as_str) == Some("terminal_stuck_cleared"))
            .expect("expected a terminal_stuck_cleared tracing event");
        assert_eq!(
            cleared.fields.get("reason").map(String::as_str),
            Some(reason),
            "the clear log must name the cause that actually fired"
        );
    }

    #[test]
    fn stuck_detection_disabled_when_window_zero_or_negative() {
        let reg = stuck_test_registry("opencode");
        reg.set_stuck_window_ms(0);
        // The full wedge shape (meaningful stale past the window, activity
        // fresh via a braille-only repaint) — must flag NOTHING while the
        // sweep is disabled.
        reg.backdate_last_activity("T", now_ms() - (STUCK_TEST_WINDOW_MS + 1));
        reg.feed("T", frame(1, "\r\x1b[2K⠋", "S"));
        assert!(reg.enforce_stuck_detection().is_empty());
        reg.set_stuck_window_ms(-1);
        assert!(reg.enforce_stuck_detection().is_empty());
    }

    /// Delta-review round 4, Finding 1 (Major): the last-subscriber teardown
    /// grace bumps (`detach` / `remove_connection`) exist for the IDLE
    /// REAPER's threshold only. A page refresh — a socket drop and re-attach,
    /// exactly what a user does to a stuck UI — must NOT reset wedge
    /// detection for another full window: the stuck sweep reads an
    /// OUTPUT-ONLY meaningful clock that the grace bumps never touch.
    #[test]
    fn page_refresh_grace_does_not_reset_wedge_detection() {
        // Arm A: explicit `detach` of the last subscriber (detach-reopen),
        // driven exactly like `detach_grants_full_idle_threshold_of_grace`.
        let reg = stuck_test_registry("opencode");
        attach_test_subscriber(&reg); // conn 1
        flag_stuck_row(&reg);
        reg.detach("T", 1); // last-subscriber teardown: the grace bump fires
                            // Re-attach a fresh subscriber (the reopen): the attach-time stuck
                            // truth still reports stuck:true — the flag survived the teardown.
        let (sink, seen) = collector();
        assert!(
            reg.attach(
                "T",
                2,
                sink,
                Some("a2".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );
        let stuck = stuck_frames(&seen);
        assert_eq!(stuck.len(), 1);
        assert!(stuck[0].stuck, "the flag survived the detach-reopen");
        // The sweep after the reconnect must emit NO clear — a wedged row
        // stays flagged instead of resetting detection for another window.
        assert!(
            reg.enforce_stuck_detection().is_empty(),
            "the detach grace bump must not clear a wedged row's stuck flag"
        );

        // Arm B: socket-drop `remove_connection` (the page-refresh /
        // transient-WS-drop path), driven exactly like
        // `disconnect_grants_full_idle_threshold_of_grace`.
        let reg = stuck_test_registry("opencode");
        attach_test_subscriber(&reg); // conn 1
        flag_stuck_row(&reg);
        reg.remove_connection(1); // last-subscriber teardown: grace bump fires
        let (sink, seen) = collector();
        assert!(
            reg.attach(
                "T",
                2,
                sink,
                Some("a2".into()),
                0,
                false,
                false,
                None,
                None,
                None,
                PacedAttachOptions::default()
            )
            .found
        );
        let stuck = stuck_frames(&seen);
        assert_eq!(stuck.len(), 1);
        assert!(stuck[0].stuck, "the flag survived the socket drop");
        assert!(
            reg.enforce_stuck_detection().is_empty(),
            "a page refresh must not reset wedge detection for another window"
        );
    }

    // Wedge-backstop Task 3: the attach-time stuck-truth emission. A NEW
    // subscriber attaching to an agent-mode Running row learns the row's
    // CURRENT stuck state in BOTH directions (stuck:true when flagged,
    // stuck:false when healthy) — the reconnect reconciliation frame. A
    // client that missed a broadcast (offline during the flag, or during
    // the clear) reconciles on re-attach; repeated keepalive re-attach
    // re-sends the frame harmlessly (the client fold is idempotent).

    /// The `terminal.stuck` frames a collector sink received, in delivery
    /// order (the `modes_syncs` pattern).
    fn stuck_frames(
        seen: &Arc<StdMutex<Vec<ServerMessage>>>,
    ) -> Vec<freshell_protocol::TerminalStuck> {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalStuck(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn attaching_to_an_agent_row_enqueues_the_current_stuck_truth_both_directions() {
        // Flagged row: the wedge shape (Task 1's helper is the ONLY way a
        // row reaches the flagged state), then a fresh subscriber attaches.
        let reg = stuck_test_registry("opencode");
        flag_stuck_row(&reg);
        let (sink, seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("att-1".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);
        let msgs = seen.lock().unwrap().clone();
        let ready_pos = msgs
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalAttachReady(_)))
            .expect("attach.ready emitted");
        let last_replay_pos = msgs
            .iter()
            .rposition(|m| matches!(m, ServerMessage::TerminalOutput(_)))
            .expect("the flagged row's scrollback replays");
        let stuck = stuck_frames(&seen);
        assert_eq!(stuck.len(), 1, "exactly one stuck frame per attach");
        assert!(stuck[0].stuck, "a flagged row's truth is stuck:true");
        assert_eq!(stuck[0].terminal_id, "T");
        let stuck_pos = msgs
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalStuck(_)))
            .expect("stuck frame emitted");
        assert!(
            ready_pos < last_replay_pos && last_replay_pos < stuck_pos,
            "ready < replay < stuck-truth (the emission follows the replay, \
             inside the attach handoff): ready={ready_pos} \
             last_replay={last_replay_pos} stuck={stuck_pos}"
        );

        // Healthy row (fresh meaningful clock): the reconnect
        // reconciliation frame carries stuck:false, so a client that
        // missed the stuck:false broadcast drops its stale card.
        let reg = stuck_test_registry("opencode");
        reg.feed("T", frame(1, "meaningful boot text\r\n", "S"));
        let (sink, seen) = collector();
        let outcome = reg.attach(
            "T",
            1,
            sink,
            Some("att-2".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(outcome.found);
        let stuck = stuck_frames(&seen);
        assert_eq!(
            stuck.len(),
            1,
            "a healthy agent row still states its truth on attach"
        );
        assert!(!stuck[0].stuck, "the healthy row's truth is stuck:false");
        assert_eq!(stuck[0].terminal_id, "T");

        // The gate: shell-mode rows and non-Running rows state NOTHING (a
        // shell pane has no stuck semantics; an exited pane is answered by
        // the synthetic exit, never a stuck card).
        let reg = stuck_test_registry("opencode");
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-shell".to_string(),
            stream_id: "S-shell".to_string(),
            mode: "shell".to_string(),
            resume_session_id: None,
            create_request_id: None,
            created_at: Some(now_ms()),
        });
        let (sink, seen) = collector();
        let _ = reg.attach(
            "T-shell",
            1,
            sink,
            None,
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(
            stuck_frames(&seen).is_empty(),
            "shell-mode rows emit no stuck truth on attach"
        );

        reg.feed("T", frame(1, "\r\x1b[2K⠋", "S"));
        assert!(reg.finish_pty_exit("T", 3));
        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            2,
            sink,
            None,
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        assert!(
            stuck_frames(&seen).is_empty(),
            "exited rows emit no stuck truth on attach (the synthetic exit answers)"
        );
    }

    #[test]
    fn attach_reconciles_a_late_clear_for_a_reconnecting_client() {
        // Flag the row, attach (sink A sees stuck:true), then meaningful
        // output clears the flag (next sweep), then a FRESH sink B attaches:
        // it must see stuck:false — a client that missed the stuck:false
        // broadcast reconciles its stale card on re-attach.
        let reg = stuck_test_registry("opencode");
        flag_stuck_row(&reg);
        let (sink_a, seen_a) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink_a,
            Some("att-a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let stuck_a = stuck_frames(&seen_a);
        assert_eq!(stuck_a.len(), 1);
        assert!(stuck_a[0].stuck, "precondition: sink A saw the flag");

        // Genuinely-new output refreshes the meaningful clocks (the
        // ingest path — the ONLY un-wedge door per the episode-3 focused
        // review; typing no longer clears), then the sweep emits the
        // true→false transition.
        reg.feed("T", frame(9, "meaningful new text line\n", "S"));
        let cleared = reg.enforce_stuck_detection();
        assert_eq!(cleared.len(), 1);
        assert!(!cleared[0].stuck);

        // The reconnect: a NEW subscriber (fresh conn id) learns stuck:false.
        let (sink_b, seen_b) = collector();
        let _ = reg.attach(
            "T",
            2,
            sink_b,
            Some("att-b".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let stuck_b = stuck_frames(&seen_b);
        assert_eq!(stuck_b.len(), 1);
        assert!(
            !stuck_b[0].stuck,
            "the reconnecting client reconciles the missed clear: stuck:false"
        );
    }

    // `compute_scrollback_max_bytes` (TERM-13, `settings.terminal.scrollback`):
    // legacy parity port of `computeScrollbackMaxChars` (`terminal-registry.ts:1328-1333`).

    #[test]
    fn compute_scrollback_max_bytes_converts_lines_via_chars_per_line() {
        // Legacy's ACTUAL settings default (`server/settings.ts:794`): 10_000
        // lines * 300 chars/line = 3_000_000 -- within [MIN, MAX], no clamp.
        assert_eq!(compute_scrollback_max_bytes(10_000), 3_000_000);
    }

    #[test]
    fn compute_scrollback_max_bytes_clamps_to_minimum() {
        // 1 line * 300 = 300, far below MIN_SCROLLBACK_CHARS (64 KiB).
        assert_eq!(compute_scrollback_max_bytes(1), 64 * 1024);
    }

    #[test]
    fn compute_scrollback_max_bytes_clamps_to_maximum() {
        // 100_000 lines * 300 = 30_000_000, far above MAX_SCROLLBACK_CHARS (4 MiB).
        assert_eq!(compute_scrollback_max_bytes(100_000), 4 * 1024 * 1024);
    }

    #[test]
    fn compute_scrollback_max_bytes_clamps_negative_input_to_minimum() {
        // A malformed/negative setting must never underflow or panic.
        assert_eq!(compute_scrollback_max_bytes(-5), 64 * 1024);
    }

    #[test]
    fn new_registry_defaults_scrollback_max_bytes_to_legacy_absent_default() {
        // `DEFAULT_MAX_SCROLLBACK_CHARS` (`terminal-registry.ts:57`): the
        // fallback when NO settings have been wired into the registry yet.
        let reg = TerminalRegistry::new();
        assert_eq!(reg.scrollback_max_bytes(), 512 * 1024);
    }

    #[test]
    fn terminal_created_after_a_small_scrollback_cap_evicts_at_that_cap() {
        // Configure a tiny cap BEFORE creating the terminal (mirrors "respected
        // at create"), then feed frames well past it and confirm the earliest
        // frame(s) were evicted -- proving `max_replay_chars` (not the old fixed
        // 8 MiB constant) drives the eviction threshold. All-ASCII data here, so
        // "10 chars" and "10 bytes" are the same 10 UTF-16 code units either way
        // -- see the box-drawing tests below for the unit-sensitive case.
        let reg = TerminalRegistry::new();
        reg.set_scrollback_max_bytes(10); // 10 chars (== bytes for ASCII) -- tiny on purpose
        reg.insert_headless("T", "S");

        reg.feed("T", frame(1, "0123456789", "S")); // 10 bytes, exactly at cap
        reg.feed("T", frame(2, "abcdefghij", "S")); // another 10 bytes -> over cap

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let replayed = outputs(&seen);
        // Whole-frame FIFO eviction keeps at least one frame; the FIRST frame
        // must have been evicted once the second pushed bytes over the cap.
        assert_eq!(replayed.len(), 1);
        assert_eq!(replayed[0].data, "abcdefghij");
    }

    #[test]
    fn terminal_created_after_a_large_scrollback_cap_retains_every_frame() {
        let reg = TerminalRegistry::new();
        reg.set_scrollback_max_bytes(4 * 1024 * 1024); // legacy MAX -- generous
        reg.insert_headless("T", "S");

        reg.feed("T", frame(1, "0123456789", "S"));
        reg.feed("T", frame(2, "abcdefghij", "S"));

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("a".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let replayed = outputs(&seen);
        assert_eq!(
            replayed.len(),
            2,
            "a generous cap must not evict either frame"
        );
    }

    // Scrollback cap UNIT parity (reviewer finding on f7b2c9e6): the cap
    // (`compute_scrollback_max_bytes`, legacy `computeScrollbackMaxChars`) is a
    // UTF-16 CODE-UNIT ("char") budget -- legacy's `ChunkRingBuffer` measures
    // `this.size += chunk.length` (JS `String.length` == UTF-16 code units), NOT
    // `Buffer.byteLength`. The retained-scrollback accounting below must count the
    // SAME unit, or non-ASCII-heavy sessions (box-drawing TUIs, unicode prompts)
    // evict far sooner than an ASCII session configured with the identical
    // `terminal.scrollback` setting.

    #[test]
    fn ascii_and_box_drawing_fills_retain_same_char_count_under_same_cap() {
        // Box-drawing chars (U+2500 range) are 1 UTF-16 code unit each but 3 UTF-8
        // bytes. A byte-denominated cap would retain roughly 1/3 as many
        // box-drawing characters as ASCII for the identical configured cap; a
        // correct char-denominated cap retains the SAME count either way.
        let cap = 12; // 12 "chars" (UTF-16 code units) -- exactly two 6-char frames.

        let reg_ascii = TerminalRegistry::new();
        reg_ascii.set_scrollback_max_bytes(cap);
        reg_ascii.insert_headless("A", "S");
        reg_ascii.feed("A", frame(1, "abcdef", "S")); // 6 chars, 6 bytes
        reg_ascii.feed("A", frame(2, "ghijkl", "S")); // 6 chars, 6 bytes -> 12 total, at cap
        let (sink_a, seen_a) = collector();
        let _ = reg_ascii.attach(
            "A",
            1,
            sink_a,
            Some("r".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let ascii_chars: usize = outputs(&seen_a)
            .iter()
            .map(|f| f.data.chars().count())
            .sum();

        let reg_box = TerminalRegistry::new();
        reg_box.set_scrollback_max_bytes(cap);
        reg_box.insert_headless("B", "S");
        // Each frame: 6 box-drawing chars = 6 UTF-16 units but 18 UTF-8 bytes.
        reg_box.feed(
            "B",
            frame(1, "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}", "S"),
        );
        reg_box.feed(
            "B",
            frame(2, "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}", "S"),
        );
        let (sink_b, seen_b) = collector();
        let _ = reg_box.attach(
            "B",
            1,
            sink_b,
            Some("r".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let box_chars: usize = outputs(&seen_b)
            .iter()
            .map(|f| f.data.chars().count())
            .sum();

        assert_eq!(
            ascii_chars, 12,
            "ascii fill retains the full 12-char budget"
        );
        assert_eq!(
            box_chars, ascii_chars,
            "box-drawing fill must retain the SAME char count as ascii under an \
             identical char-denominated cap -- a byte-denominated cap would evict \
             one whole box-drawing frame that an equivalent ascii cap keeps"
        );
    }

    // ── TERM-15/TERM-16 activity observer ───────────────────────────────────
    //
    // The registry-level tap the activity hub (freshell-ws) subscribes to:
    // Created (all modes), Input/Output (CLI modes only — shell terminals
    // never pay the tap cost), Exit (all removal paths). The observer runs on
    // the caller's thread (Input/Created) or the PTY reader thread (Output/
    // natural Exit), so it must be cheap and non-blocking — the hub forwards
    // into an unbounded channel.

    fn wait_for<F: Fn() -> bool>(deadline_ms: u64, f: F) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(deadline_ms) {
            if f() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        f()
    }

    #[test]
    fn activity_observer_sees_created_output_input_and_exit_for_cli_modes() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));

        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "printf ready-marker; sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-act".to_string(),
            "S-act".to_string(),
            "claude",
            Some("sess-act-1"),
            None,
            None,
            None,
        )
        .expect("spawn");

        // Created fires synchronously with the REAL mode + resume identity.
        {
            let events = seen.lock().unwrap();
            assert!(
                events.iter().any(|e| matches!(
                    e,
                    ActivityEvent::Created { terminal_id, mode, resume_session_id, .. }
                        if terminal_id == "T-act"
                            && mode == "claude"
                            && resume_session_id.as_deref() == Some("sess-act-1")
                )),
                "expected a Created event, got {events:?}"
            );
        }

        // Output arrives from the PTY reader thread.
        assert!(
            wait_for(5_000, || {
                seen.lock().unwrap().iter().any(|e| {
                    matches!(
                        e,
                        ActivityEvent::Output { terminal_id, data, .. }
                            if terminal_id == "T-act" && data.contains("ready-marker")
                    )
                })
            }),
            "expected an Output event carrying the PTY output"
        );

        // Input fires synchronously on write.
        assert!(reg.input("T-act", b"\r").found);
        assert!(
            seen.lock().unwrap().iter().any(|e| matches!(
                e,
                ActivityEvent::Input { terminal_id, data, .. }
                    if terminal_id == "T-act" && data == "\r"
            )),
            "expected an Input event for the Enter write"
        );

        // Kill fires Exit.
        reg.kill("T-act");
        assert!(
            wait_for(5_000, || {
                seen.lock().unwrap().iter().any(|e| {
                    matches!(
                        e,
                        ActivityEvent::Exit { terminal_id, .. } if terminal_id == "T-act"
                    )
                })
            }),
            "expected an Exit event after kill"
        );
    }

    #[test]
    fn activity_observer_skips_input_and_output_for_shell_terminals() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));

        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "printf shell-out; sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-shell".to_string(),
            "S-shell".to_string(),
            "shell",
            None,
            None,
            None,
            None,
        )
        .expect("spawn");

        // Give the PTY time to produce output; the tap must stay silent for
        // Input/Output on a plain shell (zero per-chunk overhead).
        assert!(reg.input("T-shell", b"\r").found);
        assert!(
            wait_for(2_000, || {
                // Wait until the PTY produced SOMETHING (visible via replay),
                // then check the tap saw none of it.
                reg.is_running("T-shell")
            }),
            "shell must be running"
        );
        std::thread::sleep(std::time::Duration::from_millis(300));
        let events = seen.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ActivityEvent::Created { mode, .. } if mode == "shell")),
            "Created fires for every mode"
        );
        assert!(
            !events.iter().any(|e| matches!(
                e,
                ActivityEvent::Input { .. } | ActivityEvent::Output { .. }
            )),
            "no Input/Output tap for shell terminals, got {events:?}"
        );
        drop(events);
        reg.kill("T-shell");
    }

    #[test]
    fn activity_observer_sees_exit_on_natural_pty_exit() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));
        reg.insert_headless("T-nat", "S-nat");
        assert!(reg.finish_pty_exit("T-nat", 0));
        assert!(
            seen.lock().unwrap().iter().any(|e| matches!(
                e,
                ActivityEvent::Exit { terminal_id, .. } if terminal_id == "T-nat"
            )),
            "natural exit must fire the Exit tap"
        );
    }

    #[test]
    fn kill_emits_a_non_spontaneous_exit_event() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));
        reg.insert_headless("T-kill", "S-kill");
        assert!(reg.kill("T-kill"));
        assert!(
            seen.lock().unwrap().iter().any(|e| matches!(
                e,
                ActivityEvent::Exit { terminal_id, spontaneous, .. }
                    if terminal_id == "T-kill" && !spontaneous
            )),
            "a freshell-initiated kill must emit Exit with spontaneous == false"
        );
    }

    #[test]
    fn natural_pty_exit_emits_a_spontaneous_exit_event() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));
        reg.insert_headless("T-spont", "S-spont");
        assert!(reg.finish_pty_exit("T-spont", 0));
        assert!(
            seen.lock().unwrap().iter().any(|e| matches!(
                e,
                ActivityEvent::Exit { terminal_id, spontaneous, .. }
                    if terminal_id == "T-spont" && *spontaneous
            )),
            "a natural PTY exit must emit Exit with spontaneous == true"
        );
    }

    #[test]
    fn eviction_on_box_drawing_content_never_panics_and_stays_within_char_cap() {
        // Many small multi-byte frames driving continuous eviction: proves the
        // char-count bookkeeping never underflows/panics and the retained total
        // never exceeds the configured char cap, even though every char here is a
        // 3-byte (UTF-8) / 1-unit (UTF-16) box-drawing glyph.
        let cap = 20;
        let reg = TerminalRegistry::new();
        reg.set_scrollback_max_bytes(cap);
        reg.insert_headless("T", "S");

        for i in 0..50 {
            reg.feed("T", frame(i, "\u{2500}\u{2502}\u{2503}", "S")); // 3 chars/frame
        }

        let (sink, seen) = collector();
        let _ = reg.attach(
            "T",
            1,
            sink,
            Some("r".into()),
            0,
            false,
            false,
            None,
            None,
            None,
            PacedAttachOptions::default(),
        );
        let retained_chars: usize = outputs(&seen).iter().map(|f| f.data.chars().count()).sum();
        assert!(
            retained_chars as i64 <= cap,
            "retained {retained_chars} chars must not exceed the {cap}-char cap"
        );
    }

    // ------------------------------------------------------------------
    // Reconciliation handshake (design §5.1): createRequestId stamped
    // atomically with the registry insert + the two newest-generation
    // accessors + the ≥2-live-PTYs-per-key backstop detector.
    // ------------------------------------------------------------------

    fn headless(reg: &TerminalRegistry, id: &str, key: Option<&str>, created_at: i64) {
        reg.register_headless(HeadlessTerminal {
            terminal_id: id.to_string(),
            stream_id: format!("S-{id}"),
            mode: "claude".to_string(),
            resume_session_id: None,
            create_request_id: key.map(str::to_string),
            created_at: Some(created_at),
        });
    }

    #[test]
    fn create_stamps_create_request_id_visible_via_newest_live_accessor() {
        let reg = TerminalRegistry::new();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-crid".to_string(),
            "S-crid".to_string(),
            "shell",
            None,
            Some("cr-stamp-1"),
            None,
            None,
        )
        .expect("spawn /bin/sh");

        assert_eq!(
            reg.newest_live_by_create_request_id("cr-stamp-1"),
            Some("T-crid".to_string())
        );
        reg.kill("T-crid");
    }

    #[test]
    fn newest_live_by_key_prefers_newest_generation_and_excludes_exited() {
        let reg = TerminalRegistry::new();
        headless(&reg, "gen1", Some("cr-k"), 1_000);
        headless(&reg, "gen2", Some("cr-k"), 2_000);
        // Exit the OLD generation: newest live is gen2.
        reg.finish_pty_exit("gen1", 0);
        assert_eq!(
            reg.newest_live_by_create_request_id("cr-k"),
            Some("gen2".to_string())
        );
        // Exit the newest too: no live generation left.
        reg.finish_pty_exit("gen2", 0);
        assert_eq!(reg.newest_live_by_create_request_id("cr-k"), None);
        // ... but the exited-inclusive accessor still finds the NEWEST one.
        assert_eq!(
            reg.newest_by_create_request_id("cr-k"),
            Some("gen2".to_string())
        );
        assert_eq!(reg.newest_by_create_request_id("cr-unknown"), None);
    }

    #[test]
    fn is_live_distinguishes_running_exited_and_unknown() {
        let reg = TerminalRegistry::new();
        headless(&reg, "T-live", None, 1_000);
        headless(&reg, "T-dead", None, 1_000);
        reg.finish_pty_exit("T-dead", 1);
        assert!(reg.is_live("T-live"));
        assert!(!reg.is_live("T-dead"));
        assert!(!reg.is_live("T-ghost"));
    }

    #[test]
    fn probe_returns_identity_row_with_mode_and_resume_id() {
        let reg = TerminalRegistry::new();
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-probe".to_string(),
            stream_id: "S-probe".to_string(),
            mode: "codex".to_string(),
            resume_session_id: Some("sess-9".to_string()),
            create_request_id: Some("cr-probe".to_string()),
            created_at: None,
        });
        let row = reg.probe("T-probe").expect("registered");
        assert_eq!(row.mode, "codex");
        assert_eq!(row.resume_session_id.as_deref(), Some("sess-9"));
        assert_eq!(row.status, TerminalRunStatus::Running);
        assert!(reg.probe("T-ghost").is_none());
    }

    /// §5.4 backstop detector: whenever a create completes and the key now has
    /// two or more LIVE terminals, a `ws.reconcile.duplicate_pty` warn event
    /// makes the violation loud instead of a silent second JSONL writer.
    #[test]
    fn second_live_terminal_on_one_key_emits_duplicate_pty_warning() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        headless(&reg, "dup1", Some("cr-dup"), 1_000);
        {
            let captured = events.lock().unwrap();
            assert!(
                !captured
                    .iter()
                    .any(|e| e.message == "ws.reconcile.duplicate_pty"),
                "one live terminal must not trip the detector"
            );
        }
        headless(&reg, "dup2", Some("cr-dup"), 2_000);
        let captured = events.lock().unwrap();
        let warn = captured
            .iter()
            .find(|e| e.message == "ws.reconcile.duplicate_pty")
            .expect("two live PTYs on one createRequestId must emit the detector event");
        assert_eq!(
            warn.fields.get("create_request_id").map(String::as_str),
            Some("cr-dup")
        );
    }

    /// Council rule 6 support: the registry-row join (mode +
    /// resume_session_id + Running) finds the live terminal carrying a
    /// sessionRef — exited generations and other providers/sessions never
    /// match.
    #[test]
    fn live_terminal_for_session_ref_joins_rows_on_mode_and_resume_id() {
        let reg = TerminalRegistry::new();
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-ref".to_string(),
            stream_id: "S-ref".to_string(),
            mode: "codex".to_string(),
            resume_session_id: Some("sess-r".to_string()),
            create_request_id: Some("cr-a".to_string()),
            created_at: Some(1_000),
        });
        let locator = SessionLocator {
            provider: "codex".to_string(),
            session_id: "sess-r".to_string(),
        };
        assert_eq!(
            reg.live_terminal_for_session_ref(&locator),
            Some("T-ref".to_string())
        );
        // Wrong provider / wrong session never match.
        assert!(reg
            .live_terminal_for_session_ref(&SessionLocator {
                provider: "claude".to_string(),
                session_id: "sess-r".to_string(),
            })
            .is_none());
        assert!(reg
            .live_terminal_for_session_ref(&SessionLocator {
                provider: "codex".to_string(),
                session_id: "other".to_string(),
            })
            .is_none());
        // An exited terminal is not a live carrier.
        reg.finish_pty_exit("T-ref", 0);
        assert!(reg.live_terminal_for_session_ref(&locator).is_none());
    }

    /// Council rule 9 (D8 backstop): >=2 live PTYs stamped with ONE
    /// sessionRef is the two-writers corruption shape — the alarm returns
    /// true and ERROR-logs `duplicate_pty_for_session_ref`; one live carrier
    /// returns false and stays silent.
    #[test]
    fn alarm_if_duplicate_session_ref_fires_only_on_two_live_carriers() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        let stamped = |id: &str, created_at: i64| HeadlessTerminal {
            terminal_id: id.to_string(),
            stream_id: format!("S-{id}"),
            mode: "claude".to_string(),
            resume_session_id: Some("sess-dup".to_string()),
            create_request_id: None,
            created_at: Some(created_at),
        };
        let locator = SessionLocator {
            provider: "claude".to_string(),
            session_id: "sess-dup".to_string(),
        };

        reg.register_headless(stamped("dupA", 1_000));
        assert!(
            !reg.alarm_if_duplicate_session_ref(&locator),
            "one live carrier must not trip the alarm"
        );

        reg.register_headless(stamped("dupB", 2_000));
        assert!(reg.alarm_if_duplicate_session_ref(&locator));
        let captured = events.lock().unwrap();
        let alarm = captured
            .iter()
            .find(|e| e.message.contains("duplicate_pty_for_session_ref"))
            .expect(">=2 live PTYs on one sessionRef must emit the invariant alarm");
        assert_eq!(
            alarm.fields.get("session_id").map(String::as_str),
            Some("sess-dup")
        );
    }

    // ------------------------------------------------------------------
    // Council rule 7 (D8): sessionRef liveness-bound lease — claim /
    // complete / fail / conn-death release / TTL kill-before-release.
    // ------------------------------------------------------------------

    fn test_registry() -> TerminalRegistry {
        TerminalRegistry::new()
    }

    fn locator(provider: &str, session_id: &str) -> SessionLocator {
        SessionLocator {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        }
    }

    #[test]
    fn second_claim_while_held_is_reserved() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-A", 1, 1000),
            SessionRefClaim::Acquired
        ));
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, 1500),
            SessionRefClaim::Held { .. }
        ));
    }

    #[test]
    fn completed_claim_yields_bound_elsewhere() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        reg.claim_session_ref(&s, "cr-A", 1, 1000);
        assert!(reg.complete_session_ref_claim(&s, "cr-A", "term-1"));
        match reg.claim_session_ref(&s, "cr-B", 2, 2000) {
            SessionRefClaim::BoundElsewhere { terminal_id } => assert_eq!(terminal_id, "term-1"),
            other => panic!("expected BoundElsewhere, got {other:?}"),
        }
    }

    /// winner-dies-mid-claim (council red test): holder conn death releases the
    /// pid-less lease; the loser's next claim wins.
    #[test]
    fn winner_dies_mid_claim_releases_lease() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        reg.claim_session_ref(&s, "cr-A", 1, 1000);
        let to_kill = reg.release_session_ref_leases_for_conn(1);
        assert!(to_kill.iter().all(|(_, pid)| pid.is_none()));
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, 1500),
            SessionRefClaim::Acquired
        ));
    }

    /// winner-hangs-mid-claim (council red test): TTL expiry with a recorded
    /// child pid demands kill-before-release; confirmed kill releases; a pid-less
    /// hung holder is revoked and HELD CLOSED, never released.
    #[test]
    fn winner_hangs_mid_claim_ttl_is_kill_before_release() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        reg.claim_session_ref(&s, "cr-A", 1, 1000);
        reg.set_session_ref_lease_pid(&s, "cr-A", 4242);
        let late = 1000 + SESSION_REF_LEASE_TTL_MS + 1;
        match reg.claim_session_ref(&s, "cr-B", 2, late) {
            SessionRefClaim::ExpiredNeedsKill { pid } => assert_eq!(pid, 4242),
            other => panic!("expected ExpiredNeedsKill, got {other:?}"),
        }
        reg.force_release_after_confirmed_kill(&s);
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, late + 1),
            SessionRefClaim::Acquired
        ));
    }

    #[test]
    fn hung_holder_without_pid_is_revoked_and_held_closed() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        reg.claim_session_ref(&s, "cr-A", 1, 1000);
        let late = 1000 + SESSION_REF_LEASE_TTL_MS + 1;
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, late),
            SessionRefClaim::Held { .. }
        ));
        // The revoked holder's late completion is rejected.
        assert!(!reg.complete_session_ref_claim(&s, "cr-A", "term-late"));
    }

    /// Fix round 1, finding 1: a KILLED winner must not strand the
    /// sessionRef. The kill path REMOVES the terminal row entirely
    /// ([`TerminalRegistry::kill_internal`]), so the binding's terminal id
    /// becomes UNKNOWN to the registry — the claim-time "known dead" probe
    /// can never fire. The binding must instead be pruned at row-removal
    /// time so the next claim wins, rather than answering
    /// `BoundElsewhere{dead-id}` forever.
    #[test]
    fn killed_winner_binding_is_pruned_so_next_claim_acquires() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-A", 1, 1000),
            SessionRefClaim::Acquired
        ));
        // The winner's spawn registers a real row carrying the ref, then binds.
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-win".to_string(),
            stream_id: "S-win".to_string(),
            mode: "claude".to_string(),
            resume_session_id: Some("s1".to_string()),
            create_request_id: Some("cr-A".to_string()),
            created_at: Some(1_000),
        });
        assert!(reg.complete_session_ref_claim(&s, "cr-A", "T-win"));
        // User kills the winner: the real kill path removes the row entirely.
        assert!(reg.kill("T-win"));
        // The dead winner must not strand losers.
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, 2000),
            SessionRefClaim::Acquired
        ));
    }

    /// Final-review finding 1 (claim-side TOCTOU): loser B passes checks
    /// 1a/1b while both maps are still empty, is preempted across the
    /// winner's register -> `complete_session_ref_claim` window, then takes
    /// the leases lock AFTER complete removed the lease. Pre-fix the lease
    /// phase saw "no lease" and answered `Acquired` -> a second spawn for
    /// the same sessionRef (the duplicate-writer shape D8 exists to close).
    ///
    /// Staged sequentially, no threads: the winner claims, registers its
    /// row, and completes (binding recorded, lease gone); B then enters the
    /// lease phase DIRECTLY -- exactly the state B is in after its early
    /// (empty) 1a/1b pass. A full `claim_session_ref` call from B cannot
    /// pin the fix: while the binding exists, step 1b always intercepts it,
    /// so only direct entry exercises the under-lock bindings re-check.
    #[test]
    fn lease_phase_rechecks_bindings_under_leases_lock() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-A", 1, 1000),
            SessionRefClaim::Acquired
        ));
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-win".to_string(),
            stream_id: "S-win".to_string(),
            mode: "claude".to_string(),
            resume_session_id: Some("s1".to_string()),
            create_request_id: Some("cr-A".to_string()),
            created_at: Some(1_000),
        });
        assert!(reg.complete_session_ref_claim(&s, "cr-A", "T-win"));
        // B resumes at the lease phase; its 1a/1b ran before the winner
        // existed, so neither check fired. It must NOT acquire.
        match reg.claim_session_ref_lease_phase(&s, "cr-B", 2, 2000) {
            SessionRefClaim::BoundElsewhere { terminal_id } => {
                assert_eq!(terminal_id, "T-win")
            }
            other => panic!("expected BoundElsewhere, got {other:?}"),
        }
        // The full claim path agrees (step 1a/1b catch it sequentially).
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, 2000),
            SessionRefClaim::BoundElsewhere { .. }
        ));
    }

    /// §5.1 atomic-stamp insert-edge interleave (§9.1 test 5): the key is part
    /// of the row inserted under the registry lock, so an observer's
    /// `newest_live_by_create_request_id` sees either no row or the
    /// row-with-key — never a row that later gains its key.
    #[test]
    fn concurrent_inserts_never_expose_a_row_without_its_key() {
        let reg = TerminalRegistry::new();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let reader = {
            let reg = reg.clone();
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let mut observed = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    if let Some(id) = reg.newest_live_by_create_request_id("cr-race") {
                        assert!(
                            id == "race1" || id == "race2",
                            "by-key lookup must only ever see fully-stamped rows, got {id}"
                        );
                        observed.push(id);
                    }
                }
                observed
            })
        };

        let w1 = {
            let reg = reg.clone();
            std::thread::spawn(move || headless(&reg, "race1", Some("cr-race"), 1_000))
        };
        let w2 = {
            let reg = reg.clone();
            std::thread::spawn(move || headless(&reg, "race2", Some("cr-race"), 2_000))
        };
        w1.join().unwrap();
        w2.join().unwrap();
        stop.store(true, Ordering::Relaxed);
        reader.join().unwrap();

        // After both inserts, the newest generation (by created_at) wins.
        assert_eq!(
            reg.newest_live_by_create_request_id("cr-race"),
            Some("race2".to_string())
        );
    }

    // ------------------------------------------------------------------
    // Respawn-generation cap (design §7.5): a respawn ↔ instant-exit loop
    // must converge to a terminal dead_session verdict instead of thrashing.
    // ------------------------------------------------------------------

    #[test]
    fn respawn_cap_exhausts_after_n_short_lived_generations() {
        let reg = TerminalRegistry::new();
        reg.set_respawn_liveness_window_ms(10_000);
        reg.set_respawn_generation_cap(3);

        for gen in 1..=3 {
            let id = format!("cap-gen{gen}");
            // created_at = now → the exit below is inside the liveness window.
            headless(&reg, &id, Some("cr-cap"), now_ms());
            assert!(
                !reg.respawn_exhausted("cr-cap"),
                "cap must not fire before generation {gen} exits"
            );
            reg.finish_pty_exit(&id, 1);
        }
        assert!(
            reg.respawn_exhausted("cr-cap"),
            "3 short-lived generations must exhaust the cap"
        );
        // An unrelated key is unaffected.
        assert!(!reg.respawn_exhausted("cr-other"));
    }

    #[test]
    fn healthy_generation_resets_the_respawn_counter() {
        let reg = TerminalRegistry::new();
        reg.set_respawn_liveness_window_ms(10_000);
        reg.set_respawn_generation_cap(3);

        for gen in 1..=2 {
            let id = format!("reset-gen{gen}");
            headless(&reg, &id, Some("cr-reset"), now_ms());
            reg.finish_pty_exit(&id, 1);
        }
        // A generation that SURVIVED the liveness window (created long ago)
        // exits: the counter resets — a healthy resume is not penalized.
        headless(&reg, "reset-healthy", Some("cr-reset"), now_ms() - 60_000);
        reg.finish_pty_exit("reset-healthy", 0);
        assert!(!reg.respawn_exhausted("cr-reset"));

        // The next two short-lived exits count from zero again.
        for gen in 3..=4 {
            let id = format!("reset-gen{gen}");
            headless(&reg, &id, Some("cr-reset"), now_ms());
            reg.finish_pty_exit(&id, 1);
        }
        assert!(
            !reg.respawn_exhausted("cr-reset"),
            "only 2 short-lived generations since the healthy reset"
        );
    }

    /// §5.4 single-flight claim: the in-flight keyed-create reservation that
    /// closes the check-then-spawn window between two truly concurrent
    /// creates for one key (the spawn itself takes milliseconds; the row only
    /// becomes observable at insert).
    #[test]
    fn keyed_create_claim_is_exclusive_until_released() {
        let reg = TerminalRegistry::new();
        assert!(reg.begin_keyed_create("cr-claim"), "first claim wins");
        assert!(
            !reg.begin_keyed_create("cr-claim"),
            "a second concurrent create must NOT also claim the key"
        );
        assert!(
            reg.begin_keyed_create("cr-other"),
            "unrelated keys are free"
        );
        reg.end_keyed_create("cr-claim");
        assert!(
            reg.begin_keyed_create("cr-claim"),
            "a released key is claimable again"
        );
    }

    #[test]
    fn exits_without_a_create_request_id_never_count() {
        let reg = TerminalRegistry::new();
        reg.set_respawn_liveness_window_ms(10_000);
        reg.set_respawn_generation_cap(1);
        headless(&reg, "keyless", None, now_ms());
        reg.finish_pty_exit("keyless", 1);
        assert!(!reg.respawn_exhausted(""));
    }

    #[derive(Debug)]
    struct StubIdentity {
        provider: &'static str,
        session_id: &'static str,
        terminal_id: &'static str,
    }

    impl SessionIdentityLookup for StubIdentity {
        fn terminal_for_session(&self, provider: &str, session_id: &str) -> Option<String> {
            (provider == self.provider && session_id == self.session_id)
                .then(|| self.terminal_id.to_string())
        }
    }

    #[test]
    fn live_session_owner_finds_running_row_by_resume_session_id() {
        let registry = TerminalRegistry::new();
        registry.register_headless(HeadlessTerminal {
            terminal_id: "t-row-owner".into(),
            stream_id: "s-row-owner".into(),
            mode: "claude".into(),
            resume_session_id: Some("sess-live".into()),
            create_request_id: None,
            created_at: None,
        });

        assert_eq!(
            registry.live_session_owner(None, "claude", "sess-live"),
            Some("t-row-owner".to_string()),
            "row arm: Running row with matching mode+resume_session_id is a live owner"
        );
        // Wrong mode / unknown session: no owner.
        assert_eq!(
            registry.live_session_owner(None, "codex", "sess-live"),
            None
        );
        assert_eq!(
            registry.live_session_owner(None, "claude", "sess-other"),
            None
        );

        registry.kill("t-row-owner");
    }

    #[test]
    fn live_session_owner_ignores_exited_rows() {
        let registry = TerminalRegistry::new();
        registry.register_headless(HeadlessTerminal {
            terminal_id: "t-exited".into(),
            stream_id: "s-exited".into(),
            mode: "claude".into(),
            resume_session_id: Some("sess-done".into()),
            create_request_id: None,
            created_at: None,
        });
        assert!(registry.finish_pty_exit("t-exited", 0));

        assert_eq!(
            registry.live_session_owner(None, "claude", "sess-done"),
            None,
            "an Exited owner must not block resume"
        );
    }

    #[test]
    fn live_session_owner_finds_identity_bound_running_terminal() {
        // Locator-adopted shape (d9b71f50's case): Running row with NO
        // resume_session_id; the session binding exists only in the identity store.
        let registry = TerminalRegistry::new();
        registry.register_headless(HeadlessTerminal {
            terminal_id: "t-adopted".into(),
            stream_id: "s-adopted".into(),
            mode: "codex".into(),
            resume_session_id: None,
            create_request_id: None,
            created_at: None,
        });
        let identity = StubIdentity {
            provider: "codex",
            session_id: "sess-adopted",
            terminal_id: "t-adopted",
        };

        assert_eq!(
            registry.live_session_owner(Some(&identity), "codex", "sess-adopted"),
            Some("t-adopted".to_string()),
            "identity arm: identity-bound session of a Running terminal is live"
        );

        registry.kill("t-adopted");
    }

    #[test]
    fn live_session_owner_identity_binding_to_dead_terminal_is_not_live() {
        let registry = TerminalRegistry::new();
        // No registry row at all for "t-gone" -- identity binding alone must not count.
        let identity = StubIdentity {
            provider: "codex",
            session_id: "sess-gone",
            terminal_id: "t-gone",
        };
        assert_eq!(
            registry.live_session_owner(Some(&identity), "codex", "sess-gone"),
            None,
            "identity arm requires the owner terminal to probe Running"
        );
    }

    // ------------------------------------------------------------------
    // Same-id double-resume guard (amplifier identity plan, F5/V7):
    // shared predicates over identity-probe rows.
    // ------------------------------------------------------------------

    /// Build an [`IdentityProbeRow`] with the given identity-relevant fields
    /// (remaining fields defaulted).
    fn probe_row(
        terminal_id: &str,
        mode: &str,
        status: TerminalRunStatus,
        resume_session_id: Option<&str>,
    ) -> IdentityProbeRow {
        IdentityProbeRow {
            terminal_id: terminal_id.to_string(),
            mode: mode.to_string(),
            status,
            created_at: 0,
            resume_session_id: resume_session_id.map(str::to_string),
            cwd: None,
        }
    }

    #[test]
    fn has_live_resume_matches_only_running_same_mode_same_id() {
        let rows = vec![
            probe_row("t1", "amplifier", TerminalRunStatus::Running, Some("sid-1")),
            probe_row("t2", "amplifier", TerminalRunStatus::Exited, Some("sid-2")),
            probe_row("t3", "codex", TerminalRunStatus::Running, Some("sid-3")),
        ];
        assert!(has_live_resume(&rows, "amplifier", "sid-1"));
        assert!(!has_live_resume(&rows, "amplifier", "sid-2")); // exited
        assert!(!has_live_resume(&rows, "amplifier", "sid-3")); // other mode
        assert!(!has_live_resume(&rows, "amplifier", "sid-9")); // unknown
    }

    #[test]
    fn has_other_live_resume_excludes_the_named_terminal() {
        let rows = vec![probe_row(
            "t1",
            "amplifier",
            TerminalRunStatus::Running,
            Some("sid-1"),
        )];
        assert!(!has_other_live_resume(&rows, "amplifier", "sid-1", "t1")); // only me
        assert!(has_other_live_resume(&rows, "amplifier", "sid-1", "t9")); // someone else
    }

    /// A long-lived spawn spec (stays Running for the test's lifetime) —
    /// the same `/bin/sh -c 'sleep 30'` shape the DIAG-01 create tests use.
    fn sleeper_spawn_spec() -> SpawnSpec {
        SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        }
    }

    /// **RED (F5)**: two creates, same mode `"amplifier"`, same
    /// `resume_session_id`, first still Running ⇒ the second must return
    /// `ErrorKind::AlreadyExists` (the WS/REST handlers map this to the
    /// "session already open" reject).
    #[test]
    fn amplifier_create_with_duplicate_live_resume_returns_already_exists() {
        let registry = test_registry();
        let spec = sleeper_spawn_spec();
        let env = std::collections::BTreeMap::new();
        registry
            .create(
                &spec,
                &env,
                "T-amp-dup-a".into(),
                "S-amp-dup-a".into(),
                "amplifier",
                Some("sid-dup"),
                Some("req-a"),
                None,
                None,
            )
            .expect("first create succeeds");
        let err = registry
            .create(
                &spec,
                &env,
                "T-amp-dup-b".into(),
                "S-amp-dup-b".into(),
                "amplifier",
                Some("sid-dup"),
                Some("req-b"),
                None,
                None,
            )
            .expect_err("second live resume of the same amplifier session must fail");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        registry.kill("T-amp-dup-a");
    }

    /// Release-on-success: once the first live resume is GONE (killed —
    /// kill removes the row), a new create with the same session id must
    /// succeed, proving the successful create released its reservation.
    #[test]
    fn amplifier_resume_reservation_is_released_after_successful_create() {
        let registry = test_registry();
        let spec = sleeper_spawn_spec();
        let env = std::collections::BTreeMap::new();
        registry
            .create(
                &spec,
                &env,
                "T-amp-rel-a".into(),
                "S-amp-rel-a".into(),
                "amplifier",
                Some("sid-rel"),
                Some("req-rel-a"),
                None,
                None,
            )
            .expect("first create succeeds");
        registry.kill("T-amp-rel-a");
        registry
            .create(
                &spec,
                &env,
                "T-amp-rel-b".into(),
                "S-amp-rel-b".into(),
                "amplifier",
                Some("sid-rel"),
                Some("req-rel-b"),
                None,
                None,
            )
            .expect("re-resume after the first terminal died must succeed");
        registry.kill("T-amp-rel-b");
    }

    /// Release-on-failure: a spawn failure (bad program) must release the
    /// reservation, so a subsequent valid create with the same session id
    /// succeeds instead of being wedged behind a leaked claim.
    #[test]
    fn amplifier_resume_reservation_is_released_after_spawn_failure() {
        let registry = test_registry();
        let env = std::collections::BTreeMap::new();
        let bad_spec = SpawnSpec {
            program: "/nonexistent/definitely-not-a-program".into(),
            args: vec![],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let err = registry
            .create(
                &bad_spec,
                &env,
                "T-amp-fail-a".into(),
                "S-amp-fail-a".into(),
                "amplifier",
                Some("sid-fail"),
                Some("req-fail-a"),
                None,
                None,
            )
            .expect_err("spawn of a nonexistent program must fail");
        assert_ne!(
            err.kind(),
            std::io::ErrorKind::AlreadyExists,
            "a spawn failure is not the duplicate-resume signal"
        );
        registry
            .create(
                &sleeper_spawn_spec(),
                &env,
                "T-amp-fail-b".into(),
                "S-amp-fail-b".into(),
                "amplifier",
                Some("sid-fail"),
                Some("req-fail-b"),
                None,
                None,
            )
            .expect("valid create after a failed spawn must succeed (reservation released)");
        registry.kill("T-amp-fail-b");
    }

    #[test]
    fn managed_facade_is_never_reaped_by_legacy_idle_or_shutdown_paths() {
        let registry = TerminalRegistry::new();
        registry.set_auto_kill_idle_minutes(1);
        registry.register_managed(ManagedTerminalDescriptor {
            soul_id: "soul-managed".into(),
            incarnation_id: "incarnation-managed".into(),
            terminal_id: "T-managed".into(),
            stream_id: "S-managed".into(),
            mode: "shell".into(),
            cwd: "/workspace".into(),
            resume_session_id: None,
            create_request_id: Some("req-managed".into()),
        });
        registry.backdate_last_activity("T-managed", now_ms() - 48 * 60 * 60_000);

        assert!(registry.enforce_idle_kills().is_empty());
        assert_eq!(registry.kill_all(), 0);
        assert!(registry.is_live("T-managed"));
        assert!(registry.is_managed("T-managed"));
    }

    #[test]
    fn managed_exit_marks_facade_exited_but_retains_replay_row() {
        let registry = TerminalRegistry::new();
        registry.register_managed(ManagedTerminalDescriptor {
            soul_id: "soul-exit".into(),
            incarnation_id: "incarnation-exit".into(),
            terminal_id: "T-exit".into(),
            stream_id: "S-exit".into(),
            mode: "shell".into(),
            cwd: "/workspace".into(),
            resume_session_id: None,
            create_request_id: None,
        });
        assert!(registry.ingest_managed_output("T-exit", 1, 1, "tail\n".into()));
        assert!(registry.finish_managed_exit("T-exit", 17));
        assert!(!registry.is_live("T-exit"));
        let row = registry
            .directory()
            .into_iter()
            .find(|row| row.terminal_id == "T-exit")
            .expect("managed exit row retained");
        assert_eq!(row.status, TerminalRunStatus::Exited);
        assert_eq!(row.snapshot, "tail\n");
    }

    #[test]
    fn managed_exit_waits_for_paced_replay_before_notifying_the_client() {
        let registry = TerminalRegistry::new();
        registry.set_paced_page_max_bytes(0);
        registry.register_managed(ManagedTerminalDescriptor {
            soul_id: "soul-paced-exit".into(),
            incarnation_id: "incarnation-paced-exit".into(),
            terminal_id: "T-paced-exit".into(),
            stream_id: "S-paced-exit".into(),
            mode: "opencode".into(),
            cwd: "/workspace".into(),
            resume_session_id: None,
            create_request_id: None,
        });
        for seq in 1..=3 {
            assert!(registry.ingest_managed_output(
                "T-paced-exit",
                seq,
                seq,
                format!("output-{seq}\n"),
            ));
        }
        let (sink, seen) = collector();
        let notified: Arc<StdMutex<Vec<(String, i64)>>> = Arc::new(StdMutex::new(Vec::new()));
        let notify_sink = Arc::clone(&notified);
        let start = registry
            .attach(
                "T-paced-exit",
                1,
                sink,
                Some("managed-paced-exit".into()),
                0,
                false,
                true,
                None,
                None,
                None,
                PacedAttachOptions {
                    paced_exit_notify: Some(Arc::new(move |terminal_id, exit_code| {
                        notify_sink
                            .lock()
                            .unwrap()
                            .push((terminal_id.to_string(), exit_code));
                    })),
                    ..PacedAttachOptions::default()
                },
            )
            .paced
            .expect("managed facade starts paced replay");
        for seq in 4..=6 {
            assert!(registry.ingest_managed_output(
                "T-paced-exit",
                seq,
                seq,
                format!("final-{seq}\n"),
            ));
        }
        assert!(registry.finish_managed_exit("T-paced-exit", 17));
        assert_eq!(registry.paced_exit_pending_of("T-paced-exit", 1), Some(17));
        assert_eq!(
            notified.lock().unwrap().as_slice(),
            &[("T-paced-exit".to_string(), 17)]
        );
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|message| matches!(message, ServerMessage::TerminalExit(_))));

        let mut cursor = start.session.page_end;
        loop {
            match registry.complete_paced_tail(
                "T-paced-exit",
                1,
                "managed-paced-exit",
                cursor,
                6,
                0,
            ) {
                PacedTailCompletion::Handoff { end_seq, .. } => cursor = end_seq,
                PacedTailCompletion::Completed { .. } => break,
                other => panic!("unexpected paced completion: {other:?}"),
            }
        }
        let delivered = seen.lock().unwrap();
        assert!(
            matches!(delivered.last(), Some(ServerMessage::TerminalExit(exit)) if exit.exit_code == 17)
        );
    }

    #[test]
    fn managed_output_replay_dedupes_repeated_host_cursor_reads() {
        let registry = TerminalRegistry::new();
        registry.register_managed(ManagedTerminalDescriptor {
            soul_id: "soul-output".into(),
            incarnation_id: "incarnation-output".into(),
            terminal_id: "T-output".into(),
            stream_id: "S-output".into(),
            mode: "shell".into(),
            cwd: "/workspace".into(),
            resume_session_id: None,
            create_request_id: None,
        });

        assert!(registry.ingest_managed_output("T-output", 1, 1, "one\n".into()));
        assert!(registry.ingest_managed_output("T-output", 1, 1, "duplicate\n".into()));
        assert!(registry.ingest_managed_output("T-output", 2, 2, "two\n".into()));
        let row = registry
            .directory()
            .into_iter()
            .find(|row| row.terminal_id == "T-output")
            .unwrap();
        assert_eq!(row.snapshot, "one\ntwo\n");
        assert_eq!(registry.managed_output_cursor("T-output"), Some(2));
    }
}

#[cfg(test)]
#[path = "managed_output_tests.rs"]
mod managed_output_tests;
