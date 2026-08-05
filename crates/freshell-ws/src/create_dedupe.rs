//! Server-wide `terminal.create` requestId -> terminal dedupe guard
//! (legacy: `server/ws-handler.ts` — server-global `createdByRequestId`
//! settled cache (declaration :467, lookup :2167-2172), per-connection
//! in-flight sentinel (`ClientState`, :1166; set :2434), create-lock
//! serialization (:2159-2161)). The Rust port had no equivalent (fresh
//! UUIDs minted unconditionally, terminal.rs:748; omission self-documented
//! at :805-807), and the frozen client re-sends unanswered creates with
//! the SAME requestId on every reconnect — without this guard every
//! resend spawns a duplicate PTY and orphans the original as a detached
//! background session.
//!
//! Mechanism divergence, same wire outcome: legacy serializes duplicates
//! on the create lock and answers them from the settled cache on the NEW
//! socket. Here the map is server-global with an `InFlight` sentinel, so
//! the sentinel carries the reply path itself: cross-connection
//! duplicates register their `FrameSink` as waiters; `settle` forwards
//! the stored `terminal.created` to every waiter; every non-settled exit
//! (`clear_if_in_flight`) forwards a fail-loud error instead. A silently
//! swallowed duplicate would wedge the reconnected pane in 'creating'
//! (A2, TerminalView.tsx:3995-3999).
//!
//! Eviction semantics:
//! - failed create -> the wrapper calls `clear_if_in_flight` (legacy
//!   sentinel cleanup, ws-handler.ts:2460), which also notifies waiters
//! - settled entries are retained for replay for exactly as long as their
//!   terminal is running (legacy parity with the Node server's
//!   delete-at-exit requestId pruning: `createdTerminalByRequestId` is
//!   pruned eagerly at terminal exit, ws-handler.ts:580-587, and lazily
//!   on registry miss, :914-921). Eviction is lazy -- `settle()` prunes
//!   all dead entries on access and `begin()` displaces per-id via the
//!   `is_running` probe -- with no background task. Within a terminal's
//!   running lifetime a duplicate replays the original `terminal.created`
//!   and never spawns a second terminal; after the terminal stops running
//!   a re-sent requestId is indistinguishable from a fresh create and
//!   spawns a new terminal, exactly as legacy behaves after terminal exit.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use freshell_protocol::{ErrorCode, ErrorMsg, ServerMessage};
use freshell_terminal::FrameSink;

// A `terminal.created` frame (~440 bytes) rides inline in both enums below.
// These are transient, once-per-create values (never bulk-stored beyond the
// liveness-bounded settled cache), so boxing would add indirection for no measurable
// win — and `DuplicateSettled(ServerMessage)` is the task's specified
// interface shape.
#[allow(clippy::large_enum_variant)]
enum Entry {
    /// A create with this requestId is currently gated/queued/in flight.
    InFlight {
        /// The sink of the connection running the create (it receives the
        /// reply through the normal create path — never as a waiter).
        origin: FrameSink,
        /// OTHER connections that re-sent this requestId and are owed a
        /// reply when the create settles or exits non-settled.
        waiters: Vec<FrameSink>,
        /// When this sentinel was installed — the age stamp for the
        /// `terminal_create_duplicate_in_flight` warn line (council
        /// observability follow-up, PR #552): a duplicate arriving against
        /// a MINUTES-old sentinel is a wedged create, not a race.
        started: Instant,
    },
    /// The create settled: replay this exact `terminal.created` frame.
    Settled {
        terminal_id: String,
        created: ServerMessage,
        /// The `restore` flag the SETTLED create carried. A later reuse of
        /// this `requestId` only replays when its OWN `restore` flag
        /// matches -- a genuine blind resend of the identical frame
        /// (legacy `inFlightCreates` parity: same requestId, same
        /// `restore`). A mismatched reuse (e.g. a plain create's id later
        /// reused by a `restore:true` attempt while that same terminal is
        /// still live) is a DIFFERENT request wearing the same id -- it
        /// must fall through to its own normal path (which may legitimately
        /// reject it, e.g. `RESTORE_UNAVAILABLE` while the lineage is still
        /// running) rather than silently being answered with the original
        /// terminal.
        restore: Option<bool>,
    },
}

#[allow(clippy::large_enum_variant)] // see `Entry` above
pub enum DedupeDecision {
    /// First sighting (or stale settled entry evicted): proceed to create.
    Proceed,
    /// A create with this requestId is in flight. Same connection: dropped
    /// (the in-flight create replies on this very sink). Different
    /// connection: its sink is now a registered waiter and WILL receive
    /// the settle frame or a fail-loud error — never silence.
    DuplicateInFlight,
    /// Already settled and the terminal is live: re-send the stored
    /// `terminal.created` frame instead of spawning.
    DuplicateSettled(ServerMessage),
}

/// The fail-loud frame forwarded to waiters on a non-settled exit — the
/// same `{ code, message, requestId }` shape `send_create_error` builds
/// (Task 4 Step 5), so the frozen client's requestId match
/// (TerminalView.tsx:3995-3999) fails the pane loud and its retry ladder
/// re-drives with the same requestId (the sentinel is gone by then, so
/// the retry proceeds as a fresh create).
fn waiter_error(request_id: &str) -> ServerMessage {
    ServerMessage::Error(ErrorMsg {
        code: ErrorCode::PtySpawnFailed,
        message: "terminal.create did not complete; retry".to_string(),
        timestamp: crate::now_iso(),
        actual_session_ref: None,
        expected_session_ref: None,
        request_id: Some(request_id.to_string()),
        retry_after_ms: None,
        terminal_exit_code: None,
        terminal_id: None,
    })
}

#[derive(Default)]
pub struct CreateDedupe {
    entries: Mutex<HashMap<String, Entry>>,
}

impl CreateDedupe {
    /// Register `sink` as a waiter on an in-flight entry (unless it is the
    /// origin or already registered — compared by `Arc::ptr_eq`, the
    /// per-connection sink is one Arc) and emit the duplicate-in-flight
    /// warn line with the sentinel's age (council observability follow-up).
    fn note_duplicate_in_flight(
        request_id: &str,
        sink: &FrameSink,
        origin: &FrameSink,
        waiters: &mut Vec<FrameSink>,
        started: &Instant,
    ) {
        let already_known =
            Arc::ptr_eq(origin, sink) || waiters.iter().any(|w| Arc::ptr_eq(w, sink));
        if !already_known {
            waiters.push(Arc::clone(sink));
        }
        tracing::warn!(
            target: "freshell_ws::create_dedupe",
            request_id = %request_id,
            in_flight_age_ms = started.elapsed().as_millis() as u64,
            "terminal_create_duplicate_in_flight"
        );
    }

    fn fresh_sentinel(sink: &FrameSink) -> Entry {
        Entry::InFlight {
            origin: Arc::clone(sink),
            waiters: Vec::new(),
            started: Instant::now(),
        }
    }

    /// Look up `request_id`. Registers an InFlight sentinel (with `sink`
    /// as origin) on `Proceed`; registers `sink` as a waiter on
    /// `DuplicateInFlight` when it belongs to a different connection
    /// (compared by `Arc::ptr_eq` — the per-connection sink is one Arc).
    ///
    /// LOCK DISCIPLINE (council follow-up 2c, PR #552): the `is_running`
    /// liveness probe is NEVER evaluated while the dedupe mutex is held.
    /// The probe takes two `.expect()`ed registry locks
    /// (registry.rs `is_pty_running`); probing under our lock would let ONE
    /// poisoned registry lock cascade into a permanent process-wide create
    /// outage through every "create_dedupe lock" expect. Scheme: read the
    /// settled candidate under the lock, DROP the lock, probe, re-acquire
    /// and RE-VALIDATE the entry is unchanged before acting; if it changed
    /// while unlocked, decide from the fresh entry instead of the stale
    /// snapshot.
    pub fn begin(
        &self,
        request_id: &str,
        sink: &FrameSink,
        restore: Option<bool>,
        is_running: impl Fn(&str) -> bool,
    ) -> DedupeDecision {
        // Phase 1: classify under the lock. Everything except the settled
        // liveness question resolves here in one critical section.
        let (settled_tid, settled_restore) = {
            let mut map = self.entries.lock().expect("create_dedupe lock");
            match map.get_mut(request_id) {
                Some(Entry::InFlight {
                    origin,
                    waiters,
                    started,
                }) => {
                    Self::note_duplicate_in_flight(request_id, sink, origin, waiters, started);
                    return DedupeDecision::DuplicateInFlight;
                }
                Some(Entry::Settled {
                    terminal_id,
                    restore: settled_restore,
                    ..
                }) => (terminal_id.clone(), *settled_restore),
                None => {
                    map.insert(request_id.to_string(), Self::fresh_sentinel(sink));
                    return DedupeDecision::Proceed;
                }
            }
        };

        // Phase 2: probe liveness with the lock RELEASED.
        let running = is_running(&settled_tid);

        // Phase 3: re-acquire and re-validate — the entry may have changed
        // while we probed (another begin replaced it with a sentinel; a
        // concurrent create re-settled it; a prune removed it).
        let mut map = self.entries.lock().expect("create_dedupe lock");
        #[allow(clippy::large_enum_variant)] // transient, once-per-begin; see `Entry`
        enum Act {
            Replay(ServerMessage),
            InsertSentinel,
        }
        let act = match map.get_mut(request_id) {
            Some(Entry::InFlight {
                origin,
                waiters,
                started,
            }) => {
                // Raced: another same-id create won the window while we
                // probed. Fold in as a duplicate of THAT create.
                Self::note_duplicate_in_flight(request_id, sink, origin, waiters, started);
                return DedupeDecision::DuplicateInFlight;
            }
            Some(Entry::Settled {
                terminal_id,
                created,
                restore: now_restore,
            }) => {
                let unchanged = *terminal_id == settled_tid && *now_restore == settled_restore;
                if unchanged {
                    // Same id, same `restore` flag, terminal still live: a
                    // genuine blind resend of the identical frame — replay.
                    // Same id, DIFFERENT `restore` flag: a different request
                    // wearing the same id (restore-latch flip,
                    // redriveAfterLaunchInvalidTerminal) — proceed to its
                    // own normal path. Dead terminal: evict and treat as
                    // fresh (legacy delete-at-exit parity). BOTH Proceed
                    // cases replace the stale settled entry with an
                    // InFlight sentinel (council finding: a Proceed without
                    // a sentinel leaves the in-flight window unguarded and
                    // a second duplicate inside it would also Proceed →
                    // duplicate PTY).
                    if running && settled_restore == restore {
                        Act::Replay(created.clone())
                    } else {
                        Act::InsertSentinel
                    }
                } else {
                    // Re-settled while we probed: our probe answered a
                    // stale question. The fresh entry settled microseconds
                    // ago — treat it as live (evicting it on the strength
                    // of a probe against the OLD terminal would clobber the
                    // just-settled create and re-spawn a duplicate).
                    if *now_restore == restore {
                        Act::Replay(created.clone())
                    } else {
                        Act::InsertSentinel
                    }
                }
            }
            None => Act::InsertSentinel, // pruned/cleared while unlocked: fresh
        };
        match act {
            Act::Replay(created) => {
                let terminal_id = match map.get(request_id) {
                    Some(Entry::Settled { terminal_id, .. }) => terminal_id.clone(),
                    _ => String::new(), // unreachable: Replay only chosen from a Settled arm
                };
                tracing::debug!(
                    target: "freshell_ws::create_dedupe",
                    request_id = %request_id,
                    terminal_id = %terminal_id,
                    "terminal_create_duplicate_settled_replay"
                );
                DedupeDecision::DuplicateSettled(created)
            }
            Act::InsertSentinel => {
                map.insert(request_id.to_string(), Self::fresh_sentinel(sink));
                DedupeDecision::Proceed
            }
        }
    }

    /// Record a successful create (called where `handle_create` builds and
    /// sends the `terminal.created` frame) and forward the frame to every
    /// registered waiter (non-blocking `FrameSink` call; a waiter whose
    /// connection died simply drops the frame).
    /// Also prunes settled entries whose terminal is no longer running
    /// (prune-on-access; no background task).
    pub fn settle(
        &self,
        request_id: &str,
        terminal_id: &str,
        created: &ServerMessage,
        restore: Option<bool>,
        is_running: impl Fn(&str) -> bool,
    ) {
        // Phase 1: install the settled entry, take the waiters, and SNAPSHOT
        // the prune candidates — every OTHER settled entry's (id, terminal).
        // The just-settled entry is excluded by construction: it was created
        // microseconds ago and never needs a liveness probe to be trusted.
        let (waiters, candidates) = {
            let mut map = self.entries.lock().expect("create_dedupe lock");
            let prev = map.insert(
                request_id.to_string(),
                Entry::Settled {
                    terminal_id: terminal_id.to_string(),
                    created: created.clone(),
                    restore,
                },
            );
            let candidates: Vec<(String, String)> = map
                .iter()
                .filter_map(|(id, e)| match e {
                    Entry::Settled { terminal_id, .. } if id != request_id => {
                        Some((id.clone(), terminal_id.clone()))
                    }
                    _ => None,
                })
                .collect();
            let waiters = match prev {
                Some(Entry::InFlight { waiters, .. }) => waiters,
                _ => Vec::new(),
            };
            (waiters, candidates)
        };

        // Phase 2: probe liveness with the lock RELEASED (same lock
        // discipline as `begin` — see its doc comment).
        let dead: Vec<(String, String)> = candidates
            .into_iter()
            .filter(|(_, tid)| !is_running(tid))
            .collect();

        // Phase 3: prune-on-access (house pattern; no background task): a
        // settled entry lives exactly as long as its terminal is running --
        // the legacy liveness-anchored model. Re-validate under the lock:
        // remove only entries STILL settled on the same terminal (an entry
        // replaced while we probed is left alone).
        if !dead.is_empty() {
            let mut map = self.entries.lock().expect("create_dedupe lock");
            for (id, tid) in dead {
                if matches!(
                    map.get(&id),
                    Some(Entry::Settled { terminal_id, .. }) if *terminal_id == tid
                ) {
                    map.remove(&id);
                }
            }
        }

        for w in waiters {
            w(created.clone());
        }
    }

    /// Drop the InFlight sentinel if (and only if) the create did NOT
    /// settle — gate rejection, cancellation, shutdown abandon, or
    /// handle_create failure — and forward a fail-loud error to any
    /// registered waiters. Settled entries stay while their terminal runs:
    /// that IS the dedupe (legacy parity).
    /// This is what lets the client's 2s RATE_LIMITED retry (same
    /// requestId) proceed as a fresh create.
    pub fn clear_if_in_flight(&self, request_id: &str) {
        let removed = {
            let mut map = self.entries.lock().expect("create_dedupe lock");
            if matches!(map.get(request_id), Some(Entry::InFlight { .. })) {
                map.remove(request_id)
            } else {
                None
            }
        };
        if let Some(Entry::InFlight { waiters, .. }) = removed {
            if waiters.is_empty() {
                return;
            }
            let err = waiter_error(request_id);
            for w in waiters {
                w(err.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn created_frame() -> ServerMessage {
        // Cheapest constructible variant; the guard treats it opaquely
        // (`ServerMessage` has no unit variant — same adjustment as Task 4's
        // CreateOutput test).
        ServerMessage::Pong(freshell_protocol::Pong {
            timestamp: "t".to_string(),
        })
    }

    /// A real `terminal.created` frame so a test can assert the IDENTITY
    /// (`requestId`/`terminalId`) of what each connection receives — the
    /// guard treats frames opaquely (`created_frame` above), but the TERM-04
    /// two-clients contract is about one terminal identity reaching both
    /// clients. Field set mirrors `handle_create`'s literal (terminal.rs).
    fn terminal_created_frame(request_id: &str, terminal_id: &str) -> ServerMessage {
        ServerMessage::TerminalCreated(freshell_protocol::TerminalCreated {
            created_at: 1,
            request_id: request_id.to_string(),
            terminal_id: terminal_id.to_string(),
            clear_codex_durability: None,
            cwd: None,
            notice: None,
            restore_error: None,
            session_ref: None,
        })
    }

    /// A FrameSink that records every frame it is handed.
    fn recording_sink() -> (FrameSink, Arc<Mutex<Vec<ServerMessage>>>) {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&frames);
        let sink: FrameSink = Arc::new(move |msg| {
            recorder.lock().expect("frames lock").push(msg);
        });
        (sink, frames)
    }

    #[test]
    fn settle_prunes_entries_for_non_running_terminals() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        let _ = d.begin("r1", &s, None, |_| true);
        d.settle("r1", "t1", &created_frame(), None, |_| true);
        // t1's terminal has since exited: the next successful create's
        // settle sweeps its entry out (prune-on-access; legacy parity with
        // ws-handler's eager delete-at-exit).
        let _ = d.begin("r2", &s, None, |_| true);
        d.settle("r2", "t2", &created_frame(), None, |tid| tid != "t1");
        let map = d.entries.lock().expect("lock");
        assert_eq!(
            map.len(),
            1,
            "entry for the exited terminal must be physically evicted on the next settle"
        );
        assert!(map.contains_key("r2"));
    }

    #[test]
    fn prune_keeps_running_and_in_flight_entries() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        let _ = d.begin("r1", &s, None, |_| true);
        d.settle("r1", "t1", &created_frame(), None, |_| true);
        let _ = d.begin("r2", &s, None, |_| true); // still in flight
        let _ = d.begin("r3", &s, None, |_| true);
        d.settle("r3", "t3", &created_frame(), None, |_| true); // prune runs; all running
        {
            let map = d.entries.lock().expect("lock");
            assert_eq!(
                map.len(),
                3,
                "running settled entries and in-flight sentinels survive the prune"
            );
        }
        // r1 still replays after the prune.
        assert!(matches!(
            d.begin("r1", &s, None, |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    #[test]
    fn first_begin_proceeds_and_registers_sentinel() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        assert!(matches!(
            d.begin("r1", &s1, None, |_| true),
            DedupeDecision::Proceed
        ));
        assert!(matches!(
            d.begin("r1", &s1, None, |_| true),
            DedupeDecision::DuplicateInFlight
        ));
    }

    #[test]
    fn settled_entry_replays_frame_while_live() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        let _ = d.begin("r1", &s1, None, |_| true);
        d.settle("r1", "t1", &created_frame(), None, |_| true);
        assert!(matches!(
            d.begin("r1", &s1, None, |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    #[test]
    fn dead_terminal_evicts_settled_entry() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        let _ = d.begin("r1", &s1, None, |_| true);
        d.settle("r1", "t1", &created_frame(), None, |_| true);
        assert!(matches!(
            d.begin("r1", &s1, None, |_| false),
            DedupeDecision::Proceed
        ));
    }

    #[test]
    fn clear_if_in_flight_removes_sentinel_but_not_settled() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        let _ = d.begin("r1", &s1, None, |_| true);
        d.clear_if_in_flight("r1");
        assert!(matches!(
            d.begin("r1", &s1, None, |_| true),
            DedupeDecision::Proceed
        ));
        d.settle("r1", "t1", &created_frame(), None, |_| true);
        d.clear_if_in_flight("r1");
        assert!(matches!(
            d.begin("r1", &s1, None, |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    #[test]
    fn cross_connection_waiter_receives_settle_frame() {
        let d = CreateDedupe::default();
        let (origin, origin_frames) = recording_sink();
        let (other, other_frames) = recording_sink();
        let _ = d.begin("r1", &origin, None, |_| true);
        assert!(matches!(
            d.begin("r1", &other, None, |_| true),
            DedupeDecision::DuplicateInFlight
        ));
        d.settle("r1", "t1", &created_frame(), None, |_| true);
        assert_eq!(
            other_frames.lock().expect("frames").len(),
            1,
            "cross-connection waiter must receive the settled frame"
        );
        assert!(
            origin_frames.lock().expect("frames").is_empty(),
            "the origin replies through the create path, never as a waiter"
        );
    }

    #[test]
    fn same_connection_duplicate_is_not_a_waiter() {
        let d = CreateDedupe::default();
        let (origin, origin_frames) = recording_sink();
        let _ = d.begin("r1", &origin, None, |_| true);
        let _ = d.begin("r1", &origin, None, |_| true);
        d.settle("r1", "t1", &created_frame(), None, |_| true);
        assert!(
            origin_frames.lock().expect("frames").is_empty(),
            "same-sink duplicates must not be double-answered"
        );
    }

    /// Council finding (unanimous, PR #552 follow-up): the flag-mismatch
    /// arm — settled entry exists, terminal live, but the incoming create's
    /// `restore` flag differs — returned `Proceed` WITHOUT inserting an
    /// InFlight sentinel. While that second create is in flight, another
    /// same-requestId duplicate also got `Proceed` → duplicate PTY. Two
    /// real client paths reach this: a persisted restore latch flipping a
    /// lost fresh create into a same-requestId restore:true resend across
    /// reload, and redriveAfterLaunchInvalidTerminal.
    #[test]
    fn flag_mismatch_proceed_registers_sentinel_blocking_further_duplicates() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        // Settle R as a plain (restore=false) create; terminal stays live.
        let _ = d.begin("r1", &s1, Some(false), |_| true);
        d.settle("r1", "t1", &created_frame(), Some(false), |_| true);

        // Same id, DIFFERENT flag: proceeds to its own create path...
        assert!(matches!(
            d.begin("r1", &s1, Some(true), |_| true),
            DedupeDecision::Proceed
        ));
        // ...but MUST have registered an InFlight sentinel: a second
        // duplicate while the first is unsettled must NOT also proceed.
        assert!(
            matches!(
                d.begin("r1", &s1, Some(true), |_| true),
                DedupeDecision::DuplicateInFlight
            ),
            "second same-requestId duplicate during the in-flight window must \
             be deduped, not spawn a second PTY"
        );
    }

    /// The sentinel installed by the flag-mismatch arm must behave exactly
    /// like any other InFlight entry: clear_if_in_flight drops it (waiters
    /// get the fail-loud error; a retry proceeds fresh) and settle replaces
    /// it (waiters get the settled frame).
    #[test]
    fn flag_mismatch_sentinel_supports_clear_and_settle() {
        // clear_if_in_flight path: waiter notified, retry proceeds fresh.
        let d = CreateDedupe::default();
        let (origin, _f1) = recording_sink();
        let (other, other_frames) = recording_sink();
        let _ = d.begin("r1", &origin, Some(false), |_| true);
        d.settle("r1", "t1", &created_frame(), Some(false), |_| true);
        let _ = d.begin("r1", &origin, Some(true), |_| true); // replaces Settled with InFlight
        let _ = d.begin("r1", &other, Some(true), |_| true); // cross-conn waiter
        d.clear_if_in_flight("r1");
        {
            let frames = other_frames.lock().expect("frames");
            assert_eq!(frames.len(), 1, "waiter gets the fail-loud error");
            assert!(matches!(
                &frames[0],
                ServerMessage::Error(err) if err.request_id.as_deref() == Some("r1")
            ));
        }
        assert!(matches!(
            d.begin("r1", &other, Some(true), |_| true),
            DedupeDecision::Proceed
        ));

        // settle path: the replaced entry settles normally, waiter gets the
        // frame, and the NEW settled flag governs later replays.
        let d = CreateDedupe::default();
        let (origin, _f2) = recording_sink();
        let (other, other_frames) = recording_sink();
        let _ = d.begin("r2", &origin, Some(false), |_| true);
        d.settle("r2", "t1", &created_frame(), Some(false), |_| true);
        let _ = d.begin("r2", &origin, Some(true), |_| true); // replaces Settled with InFlight
        let _ = d.begin("r2", &other, Some(true), |_| true); // waiter
        d.settle("r2", "t2", &created_frame(), Some(true), |_| true);
        assert_eq!(
            other_frames.lock().expect("frames").len(),
            1,
            "waiter receives the new settled frame"
        );
        // Replay now keys on the NEW restore flag.
        assert!(matches!(
            d.begin("r2", &other, Some(true), |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    /// Council follow-up (2c, lock decoupling): the liveness probe must
    /// NEVER run while the dedupe mutex is held — `is_running` takes two
    /// `.expect()`ed registry locks, so probing under our lock lets one
    /// poisoned registry lock cascade into a permanent process-wide create
    /// outage through the "create_dedupe lock" expects. Proof of the
    /// decoupling: a probe that RE-ENTERS the dedupe (here:
    /// clear_if_in_flight on another id) must complete instead of
    /// self-deadlocking. Under the old probe-under-lock code this test
    /// hangs forever (std::sync::Mutex is not reentrant).
    #[test]
    fn liveness_probe_can_reenter_dedupe_without_deadlock() {
        let d = Arc::new(CreateDedupe::default());
        let (s, _f) = recording_sink();
        // A settled entry so begin() must consult the probe at all.
        let _ = d.begin("r1", &s, None, |_| true);
        d.settle("r1", "t1", &created_frame(), None, |_| true);
        // An unrelated in-flight sentinel the probe will clear.
        let _ = d.begin("r-other", &s, None, |_| true);

        let d2 = Arc::clone(&d);
        let decision = d.begin("r1", &s, None, move |_| {
            // Re-entrant dedupe call from inside the probe: only possible
            // if the dedupe lock is NOT held around the probe.
            d2.clear_if_in_flight("r-other");
            true
        });
        assert!(matches!(decision, DedupeDecision::DuplicateSettled(_)));
        // The re-entrant clear really happened.
        assert!(matches!(
            d.begin("r-other", &s, None, |_| true),
            DedupeDecision::Proceed
        ));
    }

    /// The race window the unlock-probe-relock scheme must close: the
    /// entry can CHANGE while the probe runs outside the lock. If a
    /// concurrent create re-settles the same requestId onto a NEW terminal
    /// during the probe, begin() must act on the FRESH entry (replay the
    /// new frame), never on its stale pre-probe snapshot (which would
    /// evict the just-settled entry and spawn a duplicate).
    #[test]
    fn entry_resettled_during_probe_replays_fresh_frame_not_stale_eviction() {
        let d = Arc::new(CreateDedupe::default());
        let (s, _f) = recording_sink();
        let _ = d.begin("r1", &s, None, |_| true);
        d.settle("r1", "t1", &created_frame(), None, |_| true);

        let d2 = Arc::clone(&d);
        let s2 = Arc::clone(&s);
        // Probe says t1 is DEAD, and meanwhile (simulated concurrent
        // create) the id is re-settled onto live t2 with a matching flag.
        let decision = d.begin("r1", &s, None, move |_| {
            d2.settle("r1", "t2", &created_frame(), None, |_| true);
            let _ = &s2;
            false // stale snapshot's terminal (t1) is dead
        });
        assert!(
            matches!(decision, DedupeDecision::DuplicateSettled(_)),
            "the freshly re-settled entry must be replayed; acting on the \
             stale snapshot would evict it and spawn a duplicate"
        );
        // The fresh entry survives.
        assert!(matches!(
            d.begin("r1", &s, None, |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    #[test]
    fn waiters_get_fail_loud_error_on_non_settled_exit() {
        let d = CreateDedupe::default();
        let (origin, _f1) = recording_sink();
        let (other, other_frames) = recording_sink();
        let _ = d.begin("r1", &origin, None, |_| true);
        let _ = d.begin("r1", &other, None, |_| true);
        d.clear_if_in_flight("r1");
        {
            let frames = other_frames.lock().expect("frames");
            assert_eq!(frames.len(), 1, "waiter must receive a fail-loud error");
            assert!(matches!(
                &frames[0],
                ServerMessage::Error(err) if err.request_id.as_deref() == Some("r1")
            ));
        }
        // Sentinel is gone: the client's retry proceeds fresh.
        assert!(matches!(
            d.begin("r1", &other, None, |_| true),
            DedupeDecision::Proceed
        ));
    }

    /// TERM-04 two-clients + delayed-response/reconnect scenario, pinned at
    /// the guard seam where the outcome is decided: client A's create is
    /// answered LATE (spawn still in flight), client B sends the SAME
    /// requestId (two-clients-same-request), and client A's socket dies and
    /// reconnects (a NEW sink) and re-drives the same createRequestId — all
    /// before the first `terminal.created` exists. The checklist's "one PTY
    /// PID, one terminal ID, one pane owner, one fixture launch record"
    /// reduces at this layer to: exactly ONE `Proceed` for the whole
    /// sequence (every downstream effect — the PTY spawn, the registry
    /// record, the fixture launch — happens only behind that single
    /// decision) and every live connection answering with the IDENTICAL
    /// `terminal.created` frame.
    #[test]
    fn reconnect_and_second_client_during_delayed_create_get_one_frame_for_one_terminal() {
        let d = CreateDedupe::default();
        let (client_a_conn1, a_conn1_frames) = recording_sink();
        let (client_b, b_frames) = recording_sink();
        let (client_a_conn2, a_conn2_frames) = recording_sink();
        let frame = terminal_created_frame("r1", "t1");

        // Client A, connection 1: the original create; its response is
        // delayed (spawn in flight). The ONLY Proceed this scenario yields.
        let mut proceeds = 0;
        if matches!(
            d.begin("r1", &client_a_conn1, None, |_| true),
            DedupeDecision::Proceed
        ) {
            proceeds += 1;
        }
        // Client B resends the same requestId while A's create is still
        // unanswered: deduped into the in-flight window, never a respawn.
        assert!(matches!(
            d.begin("r1", &client_b, None, |_| true),
            DedupeDecision::DuplicateInFlight
        ));
        // A's socket dies mid-delay; the reconnect (fresh sink) re-drives.
        assert!(matches!(
            d.begin("r1", &client_a_conn2, None, |_| true),
            DedupeDecision::DuplicateInFlight
        ));
        // The delayed response still hasn't been written anywhere.
        assert!(a_conn1_frames.lock().expect("frames").is_empty());
        assert!(b_frames.lock().expect("frames").is_empty());
        assert!(a_conn2_frames.lock().expect("frames").is_empty());

        // The delayed create finally settles — its origin reply lands on the
        // DEAD connection (dropped), while the guard forwards the ONE settled
        // frame to both live waiters. Identical frame ⇒ the checklist's one
        // requestId AND one terminalId for every client.
        d.settle("r1", "t1", &frame, None, |_| true);
        {
            let b_got = b_frames.lock().expect("frames");
            assert_eq!(b_got.len(), 1, "client B receives exactly one frame");
            assert_eq!(b_got[0], frame);
        }
        {
            let a2_got = a_conn2_frames.lock().expect("frames");
            assert_eq!(
                a2_got.len(),
                1,
                "client A's reconnect receives exactly one frame"
            );
            assert_eq!(a2_got[0], frame);
        }
        assert!(
            a_conn1_frames.lock().expect("frames").is_empty(),
            "the dead connection is the origin — the create path, not the \
             waiter fan-out, owed it the reply it never read"
        );

        // Resends AFTER the settle (A's delayed response racing its already-
        // sent reconnect resend; a later blind resend) replay the stored
        // frame for EITHER live connection — same requestId, same terminalId,
        // no respawn. The liveness probe stays live throughout.
        for sink in [&client_a_conn2, &client_b] {
            match d.begin("r1", sink, None, |_| true) {
                DedupeDecision::DuplicateSettled(replayed) => assert_eq!(replayed, frame),
                _ => panic!("post-settle resend must replay the stored frame"),
            }
        }
        assert_eq!(
            proceeds, 1,
            "one Proceed for the whole two-clients/reconnect sequence ⇒ one spawn"
        );
        let map = d.entries.lock().expect("lock");
        assert_eq!(
            map.len(),
            1,
            "exactly one dedupe record remains, keyed by the one requestId"
        );
    }

    /// The failure half of the delayed-response/reconnect scenario: the
    /// in-flight create exits NON-settled (spawn failed / cancelled /
    /// shutdown) after client B and client A's reconnect have both re-sent
    /// the requestId. Every waiter fails LOUD with a matching requestId (so
    /// the frozen client's requestId match at TerminalView.tsx:3995-3999
    /// trips its retry ladder instead of wedging in 'creating'), the
    /// sentinel is gone, and of the two same-requestId retries EXACTLY ONE
    /// becomes the fresh create — the other folds into the new in-flight
    /// window as its waiter and settles on the new terminal.
    #[test]
    fn failed_delayed_create_fails_every_waiter_loud_then_one_retry_wins() {
        let d = CreateDedupe::default();
        let (origin, origin_frames) = recording_sink();
        let (client_b, b_frames) = recording_sink();
        let (client_a_reconnect, a_reconnect_frames) = recording_sink();
        let _ = d.begin("r1", &origin, None, |_| true);
        let _ = d.begin("r1", &client_b, None, |_| true);
        let _ = d.begin("r1", &client_a_reconnect, None, |_| true);

        d.clear_if_in_flight("r1");
        for frames in [&b_frames, &a_reconnect_frames] {
            let got = frames.lock().expect("frames");
            assert_eq!(
                got.len(),
                1,
                "each waiting client receives exactly one fail-loud error"
            );
            assert!(matches!(
                &got[0],
                ServerMessage::Error(err)
                    if err.code == ErrorCode::PtySpawnFailed
                        && err.request_id.as_deref() == Some("r1")
            ));
        }
        assert!(
            origin_frames.lock().expect("frames").is_empty(),
            "the origin's own error rides the create path, never the waiter \
             fan-out"
        );

        // Client B's same-requestId retry proceeds as the fresh create...
        assert!(matches!(
            d.begin("r1", &client_b, None, |_| true),
            DedupeDecision::Proceed
        ));
        // ...and A's reconnect retry folds into B's in-flight window.
        assert!(matches!(
            d.begin("r1", &client_a_reconnect, None, |_| true),
            DedupeDecision::DuplicateInFlight
        ));
        let frame = terminal_created_frame("r1", "t2");
        d.settle("r1", "t2", &frame, None, |_| true);
        {
            let got = a_reconnect_frames.lock().expect("frames");
            assert_eq!(
                got.len(),
                2,
                "fail-loud error, then the retry's settled frame"
            );
            assert_eq!(got[1], frame);
        }
        assert_eq!(
            b_frames.lock().expect("frames").len(),
            1,
            "the retry's origin receives its created frame via the create \
             path, never a second waiter copy"
        );
    }
}
