//! TERM-15/TERM-16 activity hub: the async wiring around the pure
//! `freshell-activity` state machines.
//!
//! One hub per server process. It:
//!
//! * consumes the [`freshell_terminal::ActivityEvent`] registry tap
//!   (Created/Input/Output/Exit) via an unbounded channel — the tap callback
//!   never blocks a PTY reader thread;
//! * routes events by terminal mode into the claude / codex / amplifier
//!   trackers (gemini/kimi and every other mode stay status-inert — TERM-16);
//! * broadcasts `*.activity.updated`, `terminal.turn.complete`, and the NEW
//!   `terminal.idle` frames on the shared server→client bus;
//! * answers `*.activity.list` requests from live tracker state (reconnect
//!   seeding — the completions carry per-terminal `completionSeq`, which is
//!   what makes the client's dedupe-across-reconnect work);
//! * owns the amplifier events.jsonl lanes: one inotify watcher + offset
//!   tailer per associated terminal, attached at `Start` for a fresh
//!   association (replays the young file's history, which is exactly the
//!   `prompt:submit` that confirms the provisional busy) or `Eof` for a
//!   resume.
//!
//! ## Zero-polling guarantee
//!
//! The hub task sleeps on (a) the event channel and (b) at most ONE one-shot
//! deadline — the min of every tracker's `next_deadline()` and the idle
//! gate's. With no busy/pending terminal and no pending idle window there is
//! NO armed timer and the task wakes only for real events. File reads happen
//! only on inotify change events or the amplifier deadman's force-read
//! failsafe; [`ActivityHubStats`] counts every tail read + timer wake so
//! tests can assert steady-state silence.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use freshell_activity::amplifier::tailer::{AttachAt, TailerReadOutcome};
use freshell_activity::amplifier::{
    create_reducer_state, reduce_amplifier_event, AmplifierActivityTracker, AmplifierEventsTailer,
    ReducerEffect, ReducerState,
};
use freshell_activity::claude::ClaudeActivityTracker;
use freshell_activity::codex::CodexActivityTracker;
use freshell_activity::idle::IdleGate;
use freshell_activity::TrackerEffect;
use freshell_protocol::{
    AgentProvider, AmplifierActivityRecord, AmplifierActivityUpdated, ClaudeActivityRecord,
    ClaudeActivityUpdated, CodexActivityRecord, CodexActivityUpdated, ServerMessage, TerminalIdle,
    TerminalTurnComplete, TurnCompletionSnapshot,
};
use freshell_terminal::ActivityEvent;

use crate::terminal::now_ms;

/// Resolves an amplifier session id to its `events.jsonl` path (used for
/// resume-created terminals, whose session dir already exists). Supplied by
/// `freshell-server` from the amplifier home; `None` when unresolvable.
pub type AmplifierEventsPathResolver = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// Diagnostics counters backing the zero-polling tests.
#[derive(Debug, Default)]
pub struct ActivityHubStats {
    /// Times the hub task woke because its one-shot deadline fired.
    pub timer_wakes: AtomicU64,
    /// Incremental tail reads of amplifier events files (change events +
    /// force-reads + attach).
    pub tail_reads: AtomicU64,
}

enum HubEvent {
    Registry(ActivityEvent),
    /// Attach an amplifier events lane (fresh association or resume).
    AmplifierAttach {
        terminal_id: String,
        session_id: String,
        events_path: PathBuf,
        attach_at: AttachAt,
    },
    /// The inotify watcher saw a change on a lane's events file.
    AmplifierFsChange {
        terminal_id: String,
    },
}

struct AmplifierLane {
    tailer: AmplifierEventsTailer,
    reducer_state: ReducerState,
    /// Keeps the inotify watcher alive for the lane's lifetime.
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
struct HubInner {
    claude: ClaudeActivityTracker,
    codex: CodexActivityTracker,
    amplifier: AmplifierActivityTracker,
    idle: IdleGate,
    /// terminal id → mode, for every tracked CLI terminal.
    modes: HashMap<String, String>,
    lanes: HashMap<String, AmplifierLane>,
}

/// Cloneable handle to the hub (stored on `WsState`).
#[derive(Clone)]
pub struct ActivityHub {
    inner: Arc<Mutex<HubInner>>,
    tx: tokio::sync::mpsc::UnboundedSender<HubEvent>,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    stats: Arc<ActivityHubStats>,
    resolver: Option<AmplifierEventsPathResolver>,
}

impl ActivityHub {
    /// Construct the hub and spawn its task. Requires a tokio runtime.
    pub fn new(
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
        resolver: Option<AmplifierEventsPathResolver>,
    ) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let hub = Self {
            inner: Arc::new(Mutex::new(HubInner::default())),
            tx,
            broadcast_tx,
            stats: Arc::new(ActivityHubStats::default()),
            resolver,
        };
        hub.spawn_task(rx);
        hub
    }

    pub fn stats(&self) -> &ActivityHubStats {
        &self.stats
    }

    /// The registry tap callback ([`freshell_terminal::TerminalRegistry::set_activity_observer`]).
    pub fn registry_observer(&self) -> freshell_terminal::ActivityObserver {
        let tx = self.tx.clone();
        Arc::new(move |event| {
            let _ = tx.send(HubEvent::Registry(event));
        })
    }

    /// Attach an amplifier events lane for a freshly-ASSOCIATED terminal
    /// (called by [`crate::amplifier_association`] once the locator resolves).
    /// `Start` replays the young file from byte 0 — the recorded
    /// `prompt:submit` is what confirms the tracker's provisional busy.
    pub fn attach_amplifier_association(
        &self,
        terminal_id: &str,
        session_id: &str,
        events_path: &Path,
    ) {
        let _ = self.tx.send(HubEvent::AmplifierAttach {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
            events_path: events_path.to_path_buf(),
            attach_at: AttachAt::Start,
        });
    }

    /// `claude.activity.list` state (records + latest completions).
    pub fn claude_list(&self) -> (Vec<ClaudeActivityRecord>, Vec<TurnCompletionSnapshot>) {
        let inner = self.inner.lock().expect("activity hub lock");
        (inner.claude.list(), inner.claude.list_latest_completions())
    }

    /// `codex.activity.list` state.
    pub fn codex_list(&self) -> (Vec<CodexActivityRecord>, Vec<TurnCompletionSnapshot>) {
        let inner = self.inner.lock().expect("activity hub lock");
        (inner.codex.list(), inner.codex.list_latest_completions())
    }

    /// `amplifier.activity.list` state.
    pub fn amplifier_list(&self) -> (Vec<AmplifierActivityRecord>, Vec<TurnCompletionSnapshot>) {
        let inner = self.inner.lock().expect("activity hub lock");
        (
            inner.amplifier.list(),
            inner.amplifier.list_latest_completions(),
        )
    }

    fn spawn_task(&self, mut rx: tokio::sync::mpsc::UnboundedReceiver<HubEvent>) {
        let hub = self.clone();
        tokio::spawn(async move {
            loop {
                let deadline = {
                    let inner = hub.inner.lock().expect("activity hub lock");
                    hub_next_deadline(&inner)
                };
                match deadline {
                    None => match rx.recv().await {
                        Some(event) => hub.handle_event(event),
                        None => break,
                    },
                    Some(deadline_ms) => {
                        let wait = std::time::Duration::from_millis(
                            (deadline_ms - now_ms()).max(0) as u64,
                        );
                        tokio::select! {
                            event = rx.recv() => match event {
                                Some(event) => hub.handle_event(event),
                                None => break,
                            },
                            _ = tokio::time::sleep(wait) => {
                                hub.stats.timer_wakes.fetch_add(1, Ordering::SeqCst);
                                hub.expire_due();
                            }
                        }
                    }
                }
            }
        });
    }

    fn emit(&self, frames: Vec<ServerMessage>) {
        for frame in frames {
            if let Ok(json) = serde_json::to_string(&frame) {
                let _ = self.broadcast_tx.send(json);
            }
        }
    }

    fn handle_event(&self, event: HubEvent) {
        match event {
            HubEvent::Registry(event) => self.handle_registry_event(event),
            HubEvent::AmplifierAttach {
                terminal_id,
                session_id,
                events_path,
                attach_at,
            } => self.attach_lane(&terminal_id, &session_id, &events_path, attach_at),
            HubEvent::AmplifierFsChange { terminal_id } => {
                self.drain_lane(&terminal_id);
            }
        }
    }

    fn handle_registry_event(&self, event: ActivityEvent) {
        match event {
            ActivityEvent::Created {
                terminal_id,
                mode,
                resume_session_id,
                at,
            } => {
                let mut frames = Vec::new();
                {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    match mode.as_str() {
                        "claude" => {
                            inner.modes.insert(terminal_id.clone(), mode.clone());
                            let effects = inner.claude.track_terminal(
                                &terminal_id,
                                resume_session_id.as_deref(),
                                at,
                            );
                            frames.extend(claude_frames(&mut inner.idle, effects));
                        }
                        "codex" => {
                            inner.modes.insert(terminal_id.clone(), mode.clone());
                            let effects = inner.codex.track_terminal(
                                &terminal_id,
                                resume_session_id.as_deref(),
                                at,
                            );
                            frames.extend(codex_frames(&mut inner.idle, effects));
                        }
                        "amplifier" => {
                            inner.modes.insert(terminal_id.clone(), mode.clone());
                            let effects = inner.amplifier.track_terminal(
                                &terminal_id,
                                resume_session_id.as_deref(),
                                at,
                            );
                            let (mut f, _force) = amplifier_frames(&mut inner.idle, effects);
                            frames.append(&mut f);
                        }
                        // Gemini/Kimi and every other mode: status-inert.
                        _ => {}
                    }
                }
                // Resume-created amplifier terminals: attach the events lane
                // at EOF via the resolver (the session dir already exists).
                if mode == "amplifier" {
                    if let (Some(resolver), Some(session_id)) =
                        (self.resolver.as_ref(), resume_session_id.as_deref())
                    {
                        if let Some(events_path) = resolver(session_id) {
                            let _ = self.tx.send(HubEvent::AmplifierAttach {
                                terminal_id: terminal_id.clone(),
                                session_id: session_id.to_string(),
                                events_path,
                                attach_at: AttachAt::Eof,
                            });
                        }
                    }
                }
                self.emit(frames);
            }
            ActivityEvent::Input {
                terminal_id,
                data,
                at,
            } => {
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let Some(mode) = inner.modes.get(&terminal_id).cloned() else {
                        return;
                    };
                    // Any submit-shaped input means "a turn may be starting":
                    // cancel a pending idle window before the tracker runs.
                    if freshell_activity::signal::is_submit_input(&data) {
                        inner.idle.note_busy(&terminal_id);
                    }
                    match mode.as_str() {
                        "claude" => {
                            let effects = inner.claude.note_input(&terminal_id, &data, at);
                            claude_frames(&mut inner.idle, effects)
                        }
                        "codex" => {
                            let effects = inner.codex.note_input(&terminal_id, &data, at);
                            codex_frames(&mut inner.idle, effects)
                        }
                        "amplifier" => {
                            let effects = inner.amplifier.note_input(&terminal_id, &data, at);
                            let (frames, _force) = amplifier_frames(&mut inner.idle, effects);
                            frames
                        }
                        _ => Vec::new(),
                    }
                };
                self.emit(frames);
            }
            ActivityEvent::Output {
                terminal_id,
                data,
                at,
            } => {
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let Some(mode) = inner.modes.get(&terminal_id).cloned() else {
                        return;
                    };
                    match mode.as_str() {
                        "claude" => {
                            let effects = inner.claude.note_output(&terminal_id, &data, at);
                            claude_frames(&mut inner.idle, effects)
                        }
                        "codex" => {
                            let effects = inner.codex.note_output(&terminal_id, &data, at);
                            codex_frames(&mut inner.idle, effects)
                        }
                        "amplifier" => {
                            inner.amplifier.note_output(&terminal_id, at);
                            Vec::new()
                        }
                        _ => Vec::new(),
                    }
                };
                self.emit(frames);
            }
            ActivityEvent::Exit { terminal_id, .. } => {
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let Some(mode) = inner.modes.remove(&terminal_id) else {
                        return;
                    };
                    inner.idle.note_exit(&terminal_id);
                    inner.lanes.remove(&terminal_id);
                    match mode.as_str() {
                        "claude" => {
                            let effects = inner.claude.note_exit(&terminal_id);
                            claude_frames(&mut inner.idle, effects)
                        }
                        "codex" => {
                            let effects = inner.codex.note_exit(&terminal_id);
                            codex_frames(&mut inner.idle, effects)
                        }
                        "amplifier" => {
                            let effects = inner.amplifier.note_exit(&terminal_id);
                            let (frames, _force) = amplifier_frames(&mut inner.idle, effects);
                            frames
                        }
                        _ => Vec::new(),
                    }
                };
                self.emit(frames);
            }
        }
    }

    fn attach_lane(
        &self,
        terminal_id: &str,
        session_id: &str,
        events_path: &Path,
        attach_at: AttachAt,
    ) {
        use notify::Watcher;
        let mut tailer = AmplifierEventsTailer::new(events_path);
        if let Err((reason, message)) = tailer.attach(attach_at) {
            tracing::warn!(
                terminal_id = %terminal_id,
                reason = ?reason,
                message = %message,
                "amplifier_events_lane_degraded: attach failed"
            );
            return;
        }
        let tx = self.tx.clone();
        let watched_terminal = terminal_id.to_string();
        let watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            // Only DATA-mutation events drive a tail read. This matters for
            // the zero-polling guarantee: our OWN read opens the file, which
            // inotify reports as `Access(..)` (IN_OPEN/IN_CLOSE_NOWRITE) and
            // — via the atime update — `Modify(Metadata(..))` (IN_ATTRIB).
            // Forwarding either would self-trigger one extra read per real
            // read. Appends arrive as `Modify(Data(..))` (IN_MODIFY);
            // `Create`/`Remove`/`Modify(Name)` cover rotation edge cases
            // (which the tailer then reports as file_reset/read_error).
            if let Ok(event) = res {
                if matches!(
                    event.kind,
                    notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
                        | notify::EventKind::Modify(notify::event::ModifyKind::Any)
                        | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                        | notify::EventKind::Create(_)
                        | notify::EventKind::Remove(_)
                        | notify::EventKind::Any
                ) {
                    let _ = tx.send(HubEvent::AmplifierFsChange {
                        terminal_id: watched_terminal.clone(),
                    });
                }
            }
        });
        let mut watcher = match watcher {
            Ok(watcher) => watcher,
            Err(error) => {
                tracing::warn!(
                    terminal_id = %terminal_id,
                    error = %error,
                    "amplifier_events_lane_degraded: watcher create failed"
                );
                return;
            }
        };
        if let Err(error) = watcher.watch(events_path, notify::RecursiveMode::NonRecursive) {
            tracing::warn!(
                terminal_id = %terminal_id,
                error = %error,
                "amplifier_events_lane_degraded: watch failed"
            );
            return;
        }

        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            // Track + bind (a resume-created terminal is already tracked; a
            // locator-associated one is too — bind_session updates identity).
            let mut frames = Vec::new();
            let track = inner
                .amplifier
                .track_terminal(terminal_id, Some(session_id), now_ms());
            let (mut f, _) = amplifier_frames(&mut inner.idle, track);
            frames.append(&mut f);
            let bind = inner.amplifier.bind_session(terminal_id, session_id);
            let (mut f, _) = amplifier_frames(&mut inner.idle, bind);
            frames.append(&mut f);
            inner.lanes.insert(
                terminal_id.to_string(),
                AmplifierLane {
                    tailer,
                    reducer_state: create_reducer_state(),
                    _watcher: watcher,
                },
            );
            frames
        };
        self.emit(frames);
        // Initial drain: at Start this replays the young file's history
        // (the prompt:submit that confirms provisional busy); at Eof it is a
        // cheap size==offset no-op that also validates readability.
        self.drain_lane(terminal_id);
    }

    /// Incremental read + reduce + apply for one lane. Called on inotify
    /// change events, force-read failsafes, and once at attach.
    fn drain_lane(&self, terminal_id: &str) {
        self.stats.tail_reads.fetch_add(1, Ordering::SeqCst);
        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let Some(mut lane) = inner.lanes.remove(terminal_id) else {
                return;
            };
            let mut frames = Vec::new();
            match lane.tailer.read() {
                TailerReadOutcome::Ok {
                    records,
                    bytes_consumed,
                    ..
                } => {
                    if bytes_consumed > 0 {
                        // File activity: the session is still doing something
                        // — extend any pending truly-idle window.
                        inner.idle.note_activity(terminal_id, now_ms());
                    }
                    for record in records {
                        let (next_state, effects) =
                            reduce_amplifier_event(&lane.reducer_state, &record);
                        lane.reducer_state = next_state;
                        for effect in effects {
                            if matches!(effect, ReducerEffect::TurnBegan { .. }) {
                                inner.idle.note_busy(terminal_id);
                            }
                            let tracker_effects =
                                inner
                                    .amplifier
                                    .apply_lifecycle(terminal_id, &effect, now_ms());
                            let (mut f, _) = amplifier_frames(&mut inner.idle, tracker_effects);
                            frames.append(&mut f);
                        }
                    }
                    inner.lanes.insert(terminal_id.to_string(), lane);
                }
                TailerReadOutcome::Degraded { reason, message } => {
                    tracing::warn!(
                        terminal_id = %terminal_id,
                        reason = ?reason,
                        message = %message,
                        "amplifier_events_lane_degraded"
                    );
                    // Signal loss: busy reverts silently; the lane (and its
                    // watcher) is dropped — no further reads.
                    let effects = inner
                        .amplifier
                        .note_events_signal_lost(terminal_id, now_ms());
                    let (mut f, _) = amplifier_frames(&mut inner.idle, effects);
                    frames.append(&mut f);
                }
            }
            frames
        };
        self.emit(frames);
    }

    /// The one-shot deadline fired: run every tracker's expiry + the idle
    /// gate, then service any amplifier force-read requests.
    fn expire_due(&self) {
        let now = now_ms();
        let (frames, force_reads) = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let mut frames = Vec::new();
            let claude = inner.claude.expire(now);
            frames.extend(claude_frames(&mut inner.idle, claude));
            let codex = inner.codex.expire(now);
            frames.extend(codex_frames(&mut inner.idle, codex));
            let amplifier = inner.amplifier.expire(now);
            let (mut f, force_reads) = amplifier_frames(&mut inner.idle, amplifier);
            frames.append(&mut f);
            for emission in inner.idle.expire(now) {
                frames.push(ServerMessage::TerminalIdle(TerminalIdle {
                    terminal_id: emission.terminal_id,
                    at: emission.at,
                    reason: emission.reason,
                }));
            }
            (frames, force_reads)
        };
        self.emit(frames);
        for terminal_id in force_reads {
            self.drain_lane(&terminal_id);
        }
    }
}

fn hub_next_deadline(inner: &HubInner) -> Option<i64> {
    [
        inner.claude.next_deadline(),
        inner.codex.next_deadline(),
        inner.amplifier.next_deadline(),
        inner.idle.next_deadline(),
    ]
    .into_iter()
    .flatten()
    .min()
}

/// Map claude tracker effects onto wire frames + idle-gate interactions.
fn claude_frames(
    idle: &mut IdleGate,
    effects: Vec<TrackerEffect<ClaudeActivityRecord>>,
) -> Vec<ServerMessage> {
    let mut frames = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                note_busy_upserts(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            r.phase == freshell_protocol::ClaudePhase::Busy,
                        )
                    }),
                );
                frames.push(ServerMessage::ClaudeActivityUpdated(
                    ClaudeActivityUpdated { remove, upsert },
                ));
            }
            TrackerEffect::TurnComplete {
                terminal_id,
                session_id,
                at,
                completion_seq,
            } => {
                idle.note_turn_boundary(&terminal_id, at);
                frames.push(turn_complete_frame(
                    AgentProvider::Claude,
                    terminal_id,
                    session_id,
                    at,
                    completion_seq,
                ));
            }
            TrackerEffect::ForceRead { .. } => {}
        }
    }
    frames
}

fn codex_frames(
    idle: &mut IdleGate,
    effects: Vec<TrackerEffect<CodexActivityRecord>>,
) -> Vec<ServerMessage> {
    let mut frames = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                note_busy_upserts(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            matches!(
                                r.phase,
                                freshell_protocol::CodexPhase::Busy
                                    | freshell_protocol::CodexPhase::Pending
                            ),
                        )
                    }),
                );
                frames.push(ServerMessage::CodexActivityUpdated(CodexActivityUpdated {
                    remove,
                    upsert,
                }));
            }
            TrackerEffect::TurnComplete {
                terminal_id,
                session_id,
                at,
                completion_seq,
            } => {
                idle.note_turn_boundary(&terminal_id, at);
                frames.push(turn_complete_frame(
                    AgentProvider::Codex,
                    terminal_id,
                    session_id,
                    at,
                    completion_seq,
                ));
            }
            TrackerEffect::ForceRead { .. } => {}
        }
    }
    frames
}

/// Amplifier effects additionally surface force-read requests (the lane
/// drains them after the lock is released).
fn amplifier_frames(
    idle: &mut IdleGate,
    effects: Vec<TrackerEffect<AmplifierActivityRecord>>,
) -> (Vec<ServerMessage>, Vec<String>) {
    let mut frames = Vec::new();
    let mut force_reads = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                note_busy_upserts(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            r.phase == freshell_protocol::AmplifierPhase::Busy,
                        )
                    }),
                );
                frames.push(ServerMessage::AmplifierActivityUpdated(
                    AmplifierActivityUpdated { remove, upsert },
                ));
            }
            TrackerEffect::TurnComplete {
                terminal_id,
                session_id,
                at,
                completion_seq,
            } => {
                idle.note_turn_boundary(&terminal_id, at);
                frames.push(turn_complete_frame(
                    AgentProvider::Amplifier,
                    terminal_id,
                    session_id,
                    at,
                    completion_seq,
                ));
            }
            TrackerEffect::ForceRead { terminal_id, .. } => force_reads.push(terminal_id),
        }
    }
    (frames, force_reads)
}

/// A busy/pending upsert cancels any pending truly-idle window.
fn note_busy_upserts<'a>(idle: &mut IdleGate, upserts: impl Iterator<Item = (&'a str, bool)>) {
    for (terminal_id, busy) in upserts {
        if busy {
            idle.note_busy(terminal_id);
        }
    }
}

fn turn_complete_frame(
    provider: AgentProvider,
    terminal_id: String,
    session_id: Option<String>,
    at: i64,
    completion_seq: i64,
) -> ServerMessage {
    ServerMessage::TerminalTurnComplete(TerminalTurnComplete {
        at,
        completion_seq,
        provider,
        terminal_id,
        session_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn hub() -> (ActivityHub, tokio::sync::broadcast::Receiver<String>) {
        let (broadcast_tx, rx) = tokio::sync::broadcast::channel::<String>(256);
        let hub = ActivityHub::new(Arc::new(broadcast_tx), None);
        (hub, rx)
    }

    fn observer_send(hub: &ActivityHub, event: ActivityEvent) {
        (hub.registry_observer())(event);
    }

    /// Wait for the first frame of `wanted` type that also satisfies `pred`.
    /// (Tracker create emits an initial `phase:"idle"` upsert — parity with
    /// legacy `commitState(state, undefined)` — so tests select the exact
    /// transition they care about instead of the first frame of a type.)
    async fn next_frame_matching(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        wanted: &str,
        timeout_ms: u64,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value = serde_json::from_str(&frame).ok()?;
                    if value["type"] == wanted && pred(&value) {
                        return Some(value);
                    }
                }
                _ => return None,
            }
        }
    }

    async fn next_frame_of_type(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        wanted: &str,
        timeout_ms: u64,
    ) -> Option<serde_json::Value> {
        next_frame_matching(rx, wanted, timeout_ms, |_| true).await
    }

    fn amplifier_line(event: &str) -> String {
        // A LIVE timestamp, like the real CLI writes: the tracker folds the
        // record's ts into last_observed_at, so a stale fixture ts would
        // (correctly!) look like >deadman silence and trigger a force-read.
        format!(
            "{}\n",
            serde_json::json!({
                "ts": crate::now_iso(),
                "schema": { "name": "amplifier.log", "ver": "1.0.0" },
                "event": event,
                "session_id": "sess-1",
                "data": {}
            })
        )
    }

    /// TERM-15: a claude submit broadcasts a busy upsert; the Stop-hook BEL
    /// broadcasts idle + exactly one TERM-16 turn.complete; the truly-idle
    /// grace then emits exactly one terminal.idle.
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_submit_bel_turn_complete_and_terminal_idle_flow() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        let busy = next_frame_matching(&mut rx, "claude.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");
        assert_eq!(busy["upsert"][0]["terminalId"], "t1");

        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        let idle_upsert = next_frame_matching(&mut rx, "claude.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("idle upsert");
        assert_eq!(idle_upsert["upsert"][0]["terminalId"], "t1");

        // The turn.complete frame followed (order: changed then completion).
        let mut rx2 = rx;
        let complete = next_frame_of_type(&mut rx2, "terminal.turn.complete", 2_000)
            .await
            .expect("turn complete");
        assert_eq!(complete["provider"], "claude");
        assert_eq!(complete["terminalId"], "t1");
        assert_eq!(complete["completionSeq"], 1);

        // The truly-idle edge fires once after the grace window.
        let idle = next_frame_of_type(&mut rx2, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle");
        assert_eq!(idle["terminalId"], "t1");
        assert_eq!(idle["reason"], "grace");

        // List state reflects the completion for reconnect seeding.
        let (records, completions) = hub.claude_list();
        assert_eq!(records.len(), 1);
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].completion_seq, 1);
    }

    /// TERM-16: a queued prompt (submit during the grace window) suppresses
    /// terminal.idle — the busy re-entry cancels the pending window.
    #[tokio::test(flavor = "multi_thread")]
    async fn queued_prompt_suppresses_terminal_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        // Queued prompt: a new submit lands right after the turn boundary.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // No terminal.idle may arrive while the next turn is running.
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_000)
                .await
                .is_none(),
            "a queued prompt must suppress terminal.idle"
        );
    }

    /// TERM-15 no-stale-state: exit broadcasts a remove and clears the list.
    #[tokio::test(flavor = "multi_thread")]
    async fn exit_broadcasts_remove_and_clears_state() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        let pending = next_frame_matching(&mut rx, "codex.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "pending"
        })
        .await
        .expect("pending upsert");
        assert_eq!(pending["upsert"][0]["terminalId"], "t1");

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
            },
        );
        let removed = next_frame_matching(&mut rx, "codex.activity.updated", 2_000, |v| {
            v["remove"][0] == "t1"
        })
        .await
        .expect("remove");
        assert_eq!(removed["remove"][0], "t1");
        let (records, _) = hub.codex_list();
        assert!(records.is_empty());
    }

    /// Gemini/Kimi terminals stay status-inert (TERM-16): no activity frames.
    #[tokio::test(flavor = "multi_thread")]
    async fn gemini_and_kimi_are_status_inert() {
        let (hub, mut rx) = hub();
        for (i, mode) in ["gemini", "kimi"].iter().enumerate() {
            observer_send(
                &hub,
                ActivityEvent::Created {
                    terminal_id: format!("t{i}"),
                    mode: mode.to_string(),
                    resume_session_id: None,
                    at: now_ms(),
                },
            );
            observer_send(
                &hub,
                ActivityEvent::Input {
                    terminal_id: format!("t{i}"),
                    data: "\r".into(),
                    at: now_ms(),
                },
            );
            observer_send(
                &hub,
                ActivityEvent::Output {
                    terminal_id: format!("t{i}"),
                    data: "\u{07}".into(),
                    at: now_ms(),
                },
            );
        }
        // Nothing may be broadcast for status-inert modes.
        let frame = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
        assert!(frame.is_err(), "status-inert modes must broadcast nothing");
        let (claude, _) = hub.claude_list();
        let (codex, _) = hub.codex_list();
        let (amplifier, _) = hub.amplifier_list();
        assert!(claude.is_empty() && codex.is_empty() && amplifier.is_empty());
    }

    /// The amplifier events lane: association attach replays the young file
    /// (prompt:submit confirms busy), a later prompt:complete broadcasts
    /// idle + turn.complete + terminal.idle — all driven by inotify, with
    /// tail reads ONLY on attach/writes (zero polling).
    #[tokio::test(flavor = "multi_thread")]
    async fn amplifier_events_lane_drives_busy_complete_and_idle_via_inotify() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(
            &events_path,
            [
                amplifier_line("session:start"),
                amplifier_line("prompt:submit"),
            ]
            .concat(),
        )
        .unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        // PTY Enter: provisional busy.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("provisional busy upsert");
        assert_eq!(busy["upsert"][0]["terminalId"], "t1");

        // Association resolves: lane attaches at Start and replays the
        // recorded prompt:submit (confirms busy — no public flap).
        hub.attach_amplifier_association("t1", "sess-1", &events_path);

        // Wait for the attach + initial drain to land (sessionId binds).
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 3_000, |v| {
            v["upsert"][0]["sessionId"] == "sess-1"
        })
        .await
        .expect("bind upsert");
        assert_eq!(bound["upsert"][0]["terminalId"], "t1");

        let reads_after_attach = hub.stats().tail_reads.load(Ordering::SeqCst);
        assert!(reads_after_attach >= 1);

        // Zero-polling: with no writes, NO further tail reads happen.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert_eq!(
            hub.stats().tail_reads.load(Ordering::SeqCst),
            reads_after_attach,
            "no writes ⇒ no tail reads (inotify-driven, never polled)"
        );

        // The turn completes: append prompt:complete — inotify drives the read.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&events_path)
            .unwrap();
        f.write_all(amplifier_line("prompt:complete").as_bytes())
            .unwrap();
        f.flush().unwrap();
        drop(f);

        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 5_000)
            .await
            .expect("amplifier turn.complete");
        assert_eq!(complete["provider"], "amplifier");
        assert_eq!(complete["sessionId"], "sess-1");

        // Truly idle after the grace window (no further file activity).
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle");
        assert_eq!(idle["terminalId"], "t1");
        assert_eq!(idle["reason"], "grace");

        assert!(
            hub.stats().tail_reads.load(Ordering::SeqCst) > reads_after_attach,
            "the write must have driven a tail read"
        );
    }

    /// Steady-state zero-wake proof: idle tracked terminals arm NO timers and
    /// read NO files. (The 20-agents-idle scenario in miniature.)
    #[tokio::test(flavor = "multi_thread")]
    async fn idle_terminals_arm_no_timers_and_read_no_files() {
        let (hub, _rx) = hub();
        for i in 0..20 {
            observer_send(
                &hub,
                ActivityEvent::Created {
                    terminal_id: format!("t{i}"),
                    mode: if i % 2 == 0 { "claude" } else { "codex" }.into(),
                    resume_session_id: None,
                    at: now_ms(),
                },
            );
        }
        // Let the hub settle, then observe a quiet window.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let wakes_before = hub.stats().timer_wakes.load(Ordering::SeqCst);
        let reads_before = hub.stats().tail_reads.load(Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(
            hub.stats().timer_wakes.load(Ordering::SeqCst),
            wakes_before,
            "20 idle tracked terminals must cause zero timer wakes"
        );
        assert_eq!(
            hub.stats().tail_reads.load(Ordering::SeqCst),
            reads_before,
            "20 idle tracked terminals must cause zero file reads"
        );
        {
            let inner = hub.inner.lock().unwrap();
            assert_eq!(hub_next_deadline(&inner), None, "no deadline while idle");
        }
    }
}
