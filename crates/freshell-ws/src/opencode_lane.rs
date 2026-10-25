//! Task 9: the per-terminal opencode SSE lane — the transport-only event
//! pump between one pane's embedded `opencode serve` (loopback HTTP+SSE) and
//! the activity hub's generation-guarded ingress
//! ([`ActivityHub::note_opencode_lane_event`]). Policy lives in the pure
//! tracker (`freshell-activity/src/opencode.rs`); this lane only gates on
//! health, subscribes, snapshots, translates, and reconnects.
//!
//! Cycle shape (Node `runMonitor:321-348` + `consumeEvents:411-471` parity —
//! connect BEFORE snapshot, A5):
//! 1. health-wait (bounded per cycle) + the log-once version drift gate;
//! 2. two-phase connect: resolves only on the FIRST `server.connected`
//!    frame, detected on the RAW decoded SSE event BEFORE
//!    `parse_serve_event` (which swallows it); frames past the ack are
//!    buffered by the returned handle, never dropped;
//! 3. `/session/status` snapshot — loss-free ONLY because the subscription
//!    already stands: every transition is either IN the snapshot or ON the
//!    open stream (/event has no replay; derives from opencode 1.18.11);
//! 4. flush the buffered frames in order, then pump live events, root-
//!    resolving unknown session ids over HTTP before forwarding (A4);
//! 5. backoff + reconnect with cycle/stream bumps.
//!
//! All IO is injected behind [`OpencodeLaneHttp`] / [`OpencodeEventStream`]
//! so the lane is unit-testable with fakes; the reqwest production impls
//! live at the bottom (wired at boot by Task 10).

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Duration;

use freshell_activity::opencode::OpencodeStatus;
use freshell_opencode::{parse_serve_event, ParsedServeEvent};

use crate::activity::{ActivityHub, OpencodeLaneEvent};

pub(crate) const OPENCODE_HEALTH_POLL_MS: u64 = 200; // mirrors Node :18
pub(crate) const OPENCODE_HEALTH_TIMEOUT_MS: u64 = 15_000; // per cycle, Node :20
pub(crate) const OPENCODE_RECONNECT_BASE_MS: u64 = 250; // Node :21
pub(crate) const OPENCODE_RECONNECT_MAX_MS: u64 = 5_000; // Node :22
pub(crate) const OPENCODE_READ_STALL_MS: u64 = 30_000; // Node :24 (production stream impl)
/// Version drift gate (log-once per lane): prefix match against the REQUIRED
/// `version` field of GET /global/health (derives from opencode 1.18.11:
/// { healthy, version } are both required; session.idle is already deprecated
/// upstream and a v1->v2 event/health migration is in progress — D8(h)).
pub(crate) const TESTED_OPENCODE_VERSION_RANGE: &str = "1.18.";

/// `true` when `version` is inside the tested vocabulary range. Out-of-range
/// versions log ONCE per lane and keep bells on (best-effort; D8(h)).
pub(crate) fn version_in_tested_range(version: &str) -> bool {
    version.starts_with(TESTED_OPENCODE_VERSION_RANGE)
}

/// Injected HTTP seam: one JSON GET (health poll, `/session/status`
/// snapshot, `/session/{id}` root resolve). The production impl applies the
/// 2s per-request timeout.
pub trait OpencodeLaneHttp: Send + Sync {
    fn get_json<'a>(
        &'a self,
        url: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<(u16, serde_json::Value), String>>;
}

/// Injected SSE seam.
pub trait OpencodeEventStream: Send + Sync {
    /// Two-phase connect (Node connect-then-snapshot parity, A5): resolves
    /// once the subscription is CONFIRMED — on the FIRST `server.connected`
    /// SSE frame, detected on the raw decoded event BEFORE `parse_serve_event`
    /// (which swallows it). Frames arriving after the ack are BUFFERED by the
    /// returned handle, never dropped.
    fn connect<'a>(
        &'a self,
        url: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<Box<dyn ConnectedOpencodeStream>, String>>;
}

/// A connected, ack'd `/event` subscription.
pub trait ConnectedOpencodeStream: Send {
    /// Deliver the buffered frames in order, then live parsed events, by
    /// sending each into `events_tx` until the stream ends (returns on
    /// disconnect; the sender is dropped on return, which is what lets the
    /// lane's pump loop drain to `None`). The seam is a CHANNEL rather than a
    /// sync callback because per-event handling must AWAIT the lane-level
    /// HTTP root resolver (`OpencodeLaneHttp::get_json` is async) before
    /// forwarding to the hub — that async work lives in the lane's pump loop
    /// (below), which owns `known_sessions` mutably. FIFO channel + one
    /// sequential pump preserves per-stream event ordering.
    fn drive(
        self: Box<Self>,
        events_tx: tokio::sync::mpsc::UnboundedSender<ParsedServeEvent>,
    ) -> futures::future::BoxFuture<'static, Result<(), String>>;
}

/// The native-title observation fold seam: `(terminal_id, session_id,
/// title)` from a `session.updated` `properties.info` payload.
pub type NativeTitleObserver = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;

/// The lane's injected IO seams. Installed on the hub once at boot
/// (`ActivityHub::set_opencode_lane_deps`); fakes in tests.
pub struct OpencodeLaneDeps {
    pub http: Arc<dyn OpencodeLaneHttp>,
    pub events: Arc<dyn OpencodeEventStream>,
    /// Unified agent names (Task 3): the native-title observation fold —
    /// `(terminal_id, session_id, title)` from a `session.updated`
    /// `properties.info` payload. `None` in tests/out-of-scope boots (the
    /// observation is then dropped, exactly like the pre-Task-3 lane). The
    /// observer is a sync callback because it only RESOLVES the target and
    /// spawns the async fold; per-event handling order is preserved by the
    /// lane's sequential pump either way.
    pub native_title_observer: Option<NativeTitleObserver>,
}

/// Spawn the per-terminal lane task. `generation` is hub-issued at attach
/// (A6) and stamped on EVERY `note_opencode_lane_event` call, so the hub's
/// ingress guard can drop stragglers from replaced lanes whole.
pub(crate) fn spawn_opencode_lane(
    deps: Arc<OpencodeLaneDeps>,
    hub: ActivityHub,
    terminal_id: String,
    base_url: String,
    generation: u64,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedSender<()>,
) {
    let (verify_tx, verify_rx) = tokio::sync::mpsc::unbounded_channel();
    let lane = Lane {
        deps,
        hub,
        terminal_id,
        base_url,
        generation,
    };
    (tokio::spawn(lane.run(verify_rx)), verify_tx)
}

/// Abort the inner drive task when the lane task itself is aborted/dropped —
/// tokio never cancels children, so without this the drive task (and the
/// response body it owns) would outlive the `opencode_lanes` teardown.
struct AbortOnDrop(tokio::task::JoinHandle<Result<(), String>>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The lane task's fixed identity; per-cycle state lives in `run`'s locals.
struct Lane {
    deps: Arc<OpencodeLaneDeps>,
    hub: ActivityHub,
    terminal_id: String,
    base_url: String,
    generation: u64,
}

impl Lane {
    fn note(&self, cycle: u64, stream: u64, event: OpencodeLaneEvent) {
        self.hub
            .note_opencode_lane_event(&self.terminal_id, self.generation, cycle, stream, event);
    }

    async fn run(self, mut verify_rx: tokio::sync::mpsc::UnboundedReceiver<()>) {
        let mut cycle: u64 = 0;
        let mut stream: u64 = 0;
        let mut backoff = OPENCODE_RECONNECT_BASE_MS;
        let mut warned_version = false;
        // Lane-lifetime root-resolver memory (A4): ids already announced to
        // the hub via SessionCreated (streamed or synthetic).
        let mut known_sessions: HashSet<String> = HashSet::new();

        loop {
            cycle += 1;
            let streamed_ok = 'cycle: {
                // 1. health-wait (bounded per cycle) + log-once version gate.
                if !self.wait_healthy(&mut warned_version).await {
                    break 'cycle false;
                }

                // 2. two-phase connect (A5): resolves once SUBSCRIBED (the
                //    first raw server.connected frame); frames decoded past
                //    the ack are buffered inside `conn`, never dropped.
                stream += 1;
                // #604 rule (a): drift bookkeeping is per stream (declared
                // where `stream += 1` happens, so every stream starts fresh).
                let mut recognized_since_verify: u64 = 0;
                let mut drift_logged_this_stream = false;
                // #608/#604 rule (b): ask ids seen as *.asked stream events
                // or replayed by the pending resync on THIS stream.
                let mut known_ask_ids: HashSet<String> = HashSet::new();
                let url = format!("{}/event", self.base_url);
                let conn = match self.deps.events.connect(&url).await {
                    Ok(conn) => conn,
                    Err(error) => {
                        tracing::debug!(
                            terminal_id = %self.terminal_id,
                            %error,
                            "opencode lane connect failed; backing off"
                        );
                        break 'cycle false;
                    }
                };

                // 3. snapshot AFTER the subscription ack: every transition is
                //    either IN the snapshot or ON the already-open stream —
                //    /event has no replay (derives from opencode 1.18.11).
                let statuses = match self.fetch_snapshot().await {
                    Ok(statuses) => statuses,
                    Err(error) => {
                        tracing::debug!(
                            terminal_id = %self.terminal_id,
                            %error,
                            "opencode lane snapshot failed; backing off"
                        );
                        // #604: a failing snapshot probe must not read
                        // as idle — surface it (crash semantics in the
                        // hub) rather than silently holding state.
                        self.note(cycle, stream, OpencodeLaneEvent::SnapshotFailed { error });
                        break 'cycle false;
                    }
                };
                // #608: replay outstanding asks BEFORE the snapshot
                // is noted. check_drift=false — asks that arrived
                // during the SSE gap are legitimately stream-unseen.
                self.resync_pending(
                    cycle,
                    stream,
                    &mut known_sessions,
                    &mut known_ask_ids,
                    &mut drift_logged_this_stream,
                    false,
                )
                .await;
                // Root-resolve unknown snapshot session ids FIRST, then note.
                for (session_id, _) in &statuses {
                    self.resolve_root(cycle, stream, session_id, &mut known_sessions)
                        .await;
                }
                // #604 rule (a): the CONNECT snapshot seeds the first REST
                // observation for the drift detector (computed before the
                // statuses are moved into the note).
                let mut last_verified_busy =
                    Some(statuses.iter().any(|(_, s)| *s != OpencodeStatus::Idle));
                self.note(cycle, stream, OpencodeLaneEvent::Snapshot { statuses });

                // 4. drive + pump (channel seam — per-event handling must
                //    AWAIT the async root resolver, so a sync callback cannot
                //    be the seam). Buffered frames flush IN ORDER, then live.
                let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
                let mut drive_task = AbortOnDrop(tokio::spawn(conn.drive(events_tx)));
                loop {
                    tokio::select! {
                        maybe_parsed = events_rx.recv() => {
                            let Some(parsed) = maybe_parsed else { break };
                            // Unified agent names (Task 3): a `session.updated`
                            // event carrying `properties.info.{id,title}` is a
                            // NATIVE title observation (automatic — never an
                            // intent claim). Folded BEFORE translation (the
                            // lane vocabulary keeps `session.updated` as
                            // activity-irrelevant); a failed fold never
                            // disturbs the activity lane.
                            if let Some(observer) = &self.deps.native_title_observer {
                                if let Some((session_id, title)) =
                                    freshell_opencode::session_title_observation(&parsed)
                                {
                                    observer(&self.terminal_id, &session_id, &title);
                                }
                            }
                            let Some(event) = translate_serve_event(&parsed) else {
                                continue;
                            };
                            if let OpencodeLaneEvent::PermissionAsked { permission_id, .. } =
                                &event
                            {
                                known_ask_ids.insert(permission_id.clone());
                            }
                            // #604 rule (a): count recognized stream events
                            // between consecutive REST observations.
                            recognized_since_verify += 1;
                            match &event {
                                OpencodeLaneEvent::SessionCreated {
                                    session_id,
                                    parent_id,
                                } => {
                                    known_sessions.insert(session_id.clone());
                                    if let Some(parent_id) = parent_id {
                                        known_sessions.insert(parent_id.clone());
                                    }
                                }
                                OpencodeLaneEvent::Status { session_id, .. }
                                | OpencodeLaneEvent::SessionIdle { session_id }
                                | OpencodeLaneEvent::SessionError { session_id, .. }
                                | OpencodeLaneEvent::PermissionAsked { session_id, .. } => {
                                    self.resolve_root(cycle, stream, session_id, &mut known_sessions)
                                        .await;
                                }
                                // No session id to resolve.
                                OpencodeLaneEvent::PermissionReplied { .. }
                                | OpencodeLaneEvent::Snapshot { .. }
                                | OpencodeLaneEvent::SnapshotFailed { .. }
                                | OpencodeLaneEvent::PermissionsSynced { .. } => {}
                            }
                            self.note(cycle, stream, event);
                        }
                        Some(()) = verify_rx.recv() => {
                            let busy = self
                                .verify(cycle, stream, &mut known_sessions)
                                .await;
                            if let Some(busy) = busy {
                                if drift_contradiction(
                                    last_verified_busy,
                                    busy,
                                    recognized_since_verify,
                                ) && !drift_logged_this_stream
                                {
                                    drift_logged_this_stream = true;
                                    OPENCODE_DRIFT_EVENTS.fetch_add(1, AtomicOrdering::SeqCst);
                                    tracing::error!(
                                        terminal_id = %self.terminal_id,
                                        "opencode stream vocabulary drift: /session/status TRANSITIONED between consecutive observations with ZERO recognized stream events in between; turn lights remain snapshot-driven (#604 rule (a))"
                                    );
                                }
                                last_verified_busy = Some(busy);
                                // A failed probe is not an observation: the counter carries across it.
                                recognized_since_verify = 0;
                            }
                            // #608 mid-stream resync + #604 rule (b) —
                            // runs ONLY here (healthy connected stream):
                            // during a disconnect an unseen listed ask is
                            // expected, not drift.
                            self.resync_pending(
                                cycle,
                                stream,
                                &mut known_sessions,
                                &mut known_ask_ids,
                                &mut drift_logged_this_stream,
                                true,
                            )
                            .await;
                        }
                    }
                }
                // rx drains to None only after drive dropped the sender on
                // disconnect — every buffered/live event was pumped, none
                // lost. Ok(Ok(())) == clean stream end.
                matches!((&mut drive_task.0).await, Ok(Ok(())))
            };

            if streamed_ok {
                // A successful streamed cycle resets the backoff to base.
                backoff = OPENCODE_RECONNECT_BASE_MS;
            }
            // 5. backoff between cycles (doubled after failures, capped).
            // Between cycles: a verify request arriving while disconnected
            // still probes once — on a dead serve that yields
            // SnapshotFailed → crash semantics, exactly the owner ruling.
            let sleep = tokio::time::sleep(Duration::from_millis(backoff));
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    Some(()) = verify_rx.recv() => {
                        // No drift bookkeeping between cycles: there is no
                        // healthy connected stream to contradict, so a
                        // transition observed across a disconnect is
                        // expected, not drift (#604 rule (a)).
                        let _ = self.verify(cycle, stream, &mut known_sessions).await;
                    }
                }
            }
            backoff = (backoff * 2).min(OPENCODE_RECONNECT_MAX_MS);
        }
    }

    /// Step 1: poll GET {base}/global/health every
    /// [`OPENCODE_HEALTH_POLL_MS`], up to [`OPENCODE_HEALTH_TIMEOUT_MS`]
    /// this cycle — the outer timeout also bounds a wedged probe (the
    /// DEV-0001 lesson: never let one stalled response defeat the deadline).
    /// Healthy == HTTP 200. On a healthy response, run the log-once version
    /// drift gate: bells stay ON either way (best-effort; D8(h)).
    async fn wait_healthy(&self, warned_version: &mut bool) -> bool {
        let url = format!("{}/global/health", self.base_url);
        let poll = async {
            loop {
                if let Ok((200, body)) = self.deps.http.get_json(&url).await {
                    // Read the REQUIRED `version` field (derives from
                    // opencode 1.18.11: /global/health returns
                    // { healthy, version }, both required).
                    let version = body.get("version").and_then(|v| v.as_str()).unwrap_or("");
                    if !version_in_tested_range(version) && !*warned_version {
                        tracing::warn!(
                            terminal_id = %self.terminal_id,
                            "opencode {version} untested for attention-bell vocabulary (tested: 1.18.x); bells stay on"
                        );
                        *warned_version = true;
                    }
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(OPENCODE_HEALTH_POLL_MS)).await;
            }
        };
        tokio::time::timeout(Duration::from_millis(OPENCODE_HEALTH_TIMEOUT_MS), poll)
            .await
            .unwrap_or(false)
    }

    /// #603: service one hub verify request — re-fetch /session/status and
    /// note the answer with the CURRENT cycle/stream stamps so the
    /// tracker's stream guards accept it. A probe failure is noted as
    /// SnapshotFailed (crash semantics downstream) — NEVER as an empty
    /// (idle-shaped) snapshot.
    /// Returns `Some(busy)` — any busy/retry entry — on a successful
    /// snapshot; `None` on probe failure (a failed probe is NOT an
    /// observation for the #604 drift detector).
    async fn verify(
        &self,
        cycle: u64,
        stream: u64,
        known_sessions: &mut HashSet<String>,
    ) -> Option<bool> {
        match self.fetch_snapshot().await {
            Ok(statuses) => {
                let busy = statuses.iter().any(|(_, s)| *s != OpencodeStatus::Idle);
                for (session_id, _) in &statuses {
                    self.resolve_root(cycle, stream, session_id, known_sessions)
                        .await;
                }
                self.note(cycle, stream, OpencodeLaneEvent::Snapshot { statuses });
                Some(busy)
            }
            Err(error) => {
                self.note(cycle, stream, OpencodeLaneEvent::SnapshotFailed { error });
                None
            }
        }
    }

    /// Step 3: GET {base}/session/status → object map. Entries whose
    /// `status.type` is busy/retry/idle map to Busy/Retry/Idle. Unknown
    /// status vocabulary degrades toward Busy (conservative-toward-busy,
    /// matching the stream translation's `_ => Busy`) + one warn. A shape
    /// break (entry is not an object with a string `type`) is a hard Err.
    async fn fetch_snapshot(&self) -> Result<Vec<(String, OpencodeStatus)>, String> {
        let url = format!("{}/session/status", self.base_url);
        let (status, body) = self.deps.http.get_json(&url).await?;
        if status != 200 {
            return Err(format!("GET /session/status returned {status}"));
        }
        let map = body
            .as_object()
            .ok_or_else(|| "GET /session/status: body is not an object".to_string())?;
        let mut statuses = Vec::new();
        for (session_id, entry) in map {
            match entry.get("type").and_then(|t| t.as_str()) {
                Some("busy") => statuses.push((session_id.clone(), OpencodeStatus::Busy)),
                Some("retry") => statuses.push((session_id.clone(), OpencodeStatus::Retry)),
                Some("idle") => statuses.push((session_id.clone(), OpencodeStatus::Idle)),
                Some(other) => {
                    // #604: unknown status VOCABULARY degrades toward busy
                    // (same conservative direction as the stream
                    // translation's `_ => Busy`) — a drifted vocabulary must
                    // never render a working agent as idle-green.
                    tracing::warn!(
                        terminal_id = %self.terminal_id,
                        session_id = %session_id,
                        status = %other,
                        "opencode /session/status: unknown status vocabulary; treating as busy"
                    );
                    statuses.push((session_id.clone(), OpencodeStatus::Busy));
                }
                None => {
                    // Shape break: the endpoint contract itself drifted.
                    return Err(format!(
                        "GET /session/status: entry for {session_id} is not an object with a string `type`"
                    ));
                }
            }
        }
        Ok(statuses)
    }

    /// #608: GET {base}/permission — pending V1 permission asks across
    /// sessions (legacy shape; source-verified on opencode v1.18.14, opId
    /// permission.list; version floor 1.18.x). Returns
    /// (session_id, ask_id) pairs. Failure is NON-FATAL for the cycle:
    /// the stream + snapshot still carry the lights; the pause resync
    /// just doesn't happen this fetch (retried at the next verify or
    /// reconnect).
    async fn fetch_permissions(&self) -> Result<Vec<(String, String)>, String> {
        Self::parse_ask_list("/permission", self.fetch_ask_body("/permission").await?)
    }

    /// #608: GET {base}/question — pending questions live in a SEPARATE
    /// store from permissions (source-verified opencode v1.18.14:
    /// question/index.ts:42-44, route groups/question.ts:11). A resync
    /// that polls only /permission never drains a question pause. Same
    /// shape contract and version floor as fetch_permissions.
    async fn fetch_questions(&self) -> Result<Vec<(String, String)>, String> {
        Self::parse_ask_list("/question", self.fetch_ask_body("/question").await?)
    }

    async fn fetch_ask_body(&self, path: &str) -> Result<serde_json::Value, String> {
        let url = format!("{}{}", self.base_url, path);
        let (status, body) = self.deps.http.get_json(&url).await?;
        if status != 200 {
            return Err(format!("GET {path} returned {status}"));
        }
        Ok(body)
    }

    fn parse_ask_list(
        path: &str,
        body: serde_json::Value,
    ) -> Result<Vec<(String, String)>, String> {
        let list = body
            .as_array()
            .ok_or_else(|| format!("GET {path}: body is not an array"))?;
        let mut asks = Vec::new();
        for entry in list {
            let (Some(session_id), Some(ask_id)) = (
                entry.get("sessionID").and_then(|v| v.as_str()),
                entry.get("id").and_then(|v| v.as_str()),
            ) else {
                return Err(format!("GET {path}: entry missing id/sessionID"));
            };
            asks.push((session_id.to_string(), ask_id.to_string()));
        }
        Ok(asks)
    }

    /// #608: fetch BOTH pending-ask sets and replay them into the
    /// tracker (idempotent — only a NEWLY inserted id arms,
    /// opencode.rs:508-510); when BOTH fetches succeed, note
    /// PermissionsSynced so the hub drains stale local pauses
    /// (instance-dispose drains pending with NO events). Reconciliation
    /// is all-or-nothing: draining question pauses because only
    /// /permission answered would wedge the truth. With `check_drift`
    /// (mid-stream verify only): a listed id never seen as an *.asked
    /// stream event nor replayed before is #604 rule (b) drift — every
    /// ask minted on a healthy stream publishes *.asked at ask time.
    /// Connect-time calls pass check_drift=false: asks that arrived
    /// during the SSE gap are expected to be stream-unseen.
    #[allow(clippy::too_many_arguments)]
    async fn resync_pending(
        &self,
        cycle: u64,
        stream: u64,
        known_sessions: &mut HashSet<String>,
        known_ask_ids: &mut HashSet<String>,
        drift_logged_this_stream: &mut bool,
        check_drift: bool,
    ) {
        let perms = self.fetch_permissions().await;
        let questions = self.fetch_questions().await;
        let both_ok = perms.is_ok() && questions.is_ok();
        if !both_ok {
            let error = [perms.as_ref().err(), questions.as_ref().err()]
                .into_iter()
                .flatten()
                .cloned()
                .collect::<Vec<_>>()
                .join("; ");
            tracing::warn!(
                terminal_id = %self.terminal_id,
                %error,
                "opencode pending-ask resync incomplete; replaying what fetched, skipping reconciliation (#608)"
            );
        }
        let listed: Vec<(String, String)> = perms
            .unwrap_or_default()
            .into_iter()
            .chain(questions.unwrap_or_default())
            .collect();
        if check_drift {
            let unseen = unseen_pending_asks(&listed, known_ask_ids);
            if !unseen.is_empty() && !*drift_logged_this_stream {
                *drift_logged_this_stream = true;
                OPENCODE_DRIFT_EVENTS.fetch_add(1, AtomicOrdering::SeqCst);
                tracing::error!(
                    terminal_id = %self.terminal_id,
                    unseen = ?unseen,
                    "opencode asked-family drift: pending ask ids listed by /permission|/question were never seen as *.asked stream events on a healthy stream (#604 rule (b))"
                );
            }
        }
        let mut pending_ids = Vec::new();
        for (session_id, ask_id) in listed {
            self.resolve_root(cycle, stream, &session_id, known_sessions)
                .await;
            known_ask_ids.insert(ask_id.clone());
            pending_ids.push(ask_id.clone());
            self.note(
                cycle,
                stream,
                OpencodeLaneEvent::PermissionAsked {
                    session_id,
                    permission_id: ask_id,
                },
            );
        }
        if both_ok {
            self.note(
                cycle,
                stream,
                OpencodeLaneEvent::PermissionsSynced { pending_ids },
            );
        }
    }

    /// Lane-level HTTP root resolver (A4 — the Node `resolveRootForEvent` /
    /// `classifySnapshotStatuses` seam, ported to HTTP). A session id unseen
    /// on-stream is resolved via GET {base}/session/{id} and announced to
    /// the hub as synthetic `SessionCreated` events BEFORE the triggering
    /// event — first walking the `parentID` chain while the parent is itself
    /// unknown, then emitting deepest ancestor first, so every mapping lands
    /// before its dependents. On resolve failure (non-200, timeout, shape
    /// mismatch) nothing is emitted or remembered: the caller forwards the
    /// triggering event anyway (the tracker's conservative-ambiguity
    /// behavior stands) and the next unknown-id occurrence retries.
    ///
    /// Runs in the lane task itself — inside the step-4 pump for streamed
    /// events, inline in step 3 for snapshot entries — so every
    /// `deps.http.get_json` await happens where `&mut known_sessions` is
    /// directly in scope, and the sequential pump preserves the
    /// emit-before-trigger ordering.
    // derives from opencode 1.18.11: GET /session/{id} exposes parentID; /event has no replay
    async fn resolve_root(
        &self,
        cycle: u64,
        stream: u64,
        session_id: &str,
        known_sessions: &mut HashSet<String>,
    ) {
        if known_sessions.contains(session_id) {
            return;
        }
        // (id, parent) pairs, triggering id first.
        let mut chain: Vec<(String, Option<String>)> = Vec::new();
        let mut current = session_id.to_string();
        loop {
            let url = format!("{}/session/{current}", self.base_url);
            let (status, body) = match self.deps.http.get_json(&url).await {
                Ok(response) => response,
                Err(error) => {
                    tracing::debug!(
                        terminal_id = %self.terminal_id,
                        session_id = %current,
                        %error,
                        "opencode root resolve failed; forwarding unresolved"
                    );
                    return;
                }
            };
            if status != 200 || !body.is_object() {
                tracing::debug!(
                    terminal_id = %self.terminal_id,
                    session_id = %current,
                    status,
                    "opencode root resolve rejected; forwarding unresolved"
                );
                return;
            }
            let parent_id = body
                .get("parentID")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            chain.push((current.clone(), parent_id.clone()));
            match parent_id {
                // Walk up only while the parent is unknown; the chain guard
                // breaks a (malformed) parentID cycle.
                Some(parent)
                    if !known_sessions.contains(&parent)
                        && !chain.iter().any(|(id, _)| id == &parent) =>
                {
                    current = parent;
                }
                _ => break,
            }
        }
        // Deepest ancestor first: the root mapping lands before dependents.
        for (id, parent_id) in chain.into_iter().rev() {
            known_sessions.insert(id.clone());
            if let Some(parent) = &parent_id {
                known_sessions.insert(parent.clone());
            }
            self.note(
                cycle,
                stream,
                OpencodeLaneEvent::SessionCreated {
                    session_id: id,
                    parent_id,
                },
            );
        }
    }
}

/// Translate one parsed serve event into the hub's lane vocabulary. Kinds
/// and property paths are verbatim from the spike (vocabulary.md).
pub(crate) fn translate_serve_event(event: &ParsedServeEvent) -> Option<OpencodeLaneEvent> {
    let props = &event.properties;
    match event.kind.as_str() {
        "session.created" => {
            let info = props.get("info")?.as_object()?;
            let session_id = info.get("id")?.as_str()?.to_string();
            let parent_id = info
                .get("parentID")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            Some(OpencodeLaneEvent::SessionCreated {
                session_id,
                parent_id,
            })
        }
        "session.status" => {
            let session_id = props.get("sessionID")?.as_str()?.to_string();
            let status = match props.get("status")?.get("type")?.as_str()? {
                "idle" => OpencodeStatus::Idle,
                // schema-declared, never observed live (opencode 1.18.11) — busy-equivalent
                "retry" => OpencodeStatus::Retry,
                _ => OpencodeStatus::Busy,
            };
            Some(OpencodeLaneEvent::Status { session_id, status })
        }
        "session.idle" => Some(OpencodeLaneEvent::SessionIdle {
            session_id: props.get("sessionID")?.as_str()?.to_string(),
        }),
        "session.error" => Some(OpencodeLaneEvent::SessionError {
            session_id: props.get("sessionID")?.as_str()?.to_string(),
            error_name: props
                .get("error")
                .and_then(|e| e.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("UnknownError")
                .to_string(),
        }),
        // #604: v1 + v2 + question families all feed the SAME two lane
        // events (one reducer, many spellings). Source-verified against
        // opencode v1.18.14: TUI-driven turns emit the V1 names
        // (permission.asked / question.asked / question.replied /
        // question.rejected); the v2 names fire only via the /api/*
        // routes and are forward-compat here. v2 renames payload fields
        // freshell doesn't read (permission→action, patterns→resources,
        // always→save, tool→source) and keeps id/sessionID; question ids
        // (^que) can't collide with permission ids (^per), so questions
        // reuse the permission pause machinery unchanged.
        // question.rejected ends the pause exactly like a reply. NO
        // permission.*.rejected type exists: permission rejection is a
        // *.replied with reply:"reject", which this arm already drains
        // (the reply value is deliberately not inspected).
        "permission.asked" | "permission.v2.asked" | "question.asked" | "question.v2.asked" => {
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: props.get("sessionID")?.as_str()?.to_string(),
                permission_id: props.get("id")?.as_str()?.to_string(),
            })
        }
        "permission.replied"
        | "permission.v2.replied"
        | "question.replied"
        | "question.v2.replied"
        | "question.rejected"
        | "question.v2.rejected" => Some(OpencodeLaneEvent::PermissionReplied {
            permission_id: props.get("requestID")?.as_str()?.to_string(),
        }),
        "message.updated" => {
            // W2 abort marker (derives from opencode 1.18.11): an abort landing
            // between assistant-message creation and LLM stream start emits NO
            // session.error — only message.updated with info.error.name ===
            // "MessageAbortedError", always BEFORE idle. Error-less
            // message.updated is routine message churn -> None. Both abort
            // signals feed the same SessionError lane event (D1).
            let session_id = props.get("sessionID")?.as_str()?.to_string();
            let error_name = props
                .get("info")?
                .get("error")?
                .get("name")?
                .as_str()?
                .to_string();
            Some(OpencodeLaneEvent::SessionError {
                session_id,
                error_name,
            })
        }
        // message.part.*, message.removed, session.updated, session.diff,
        // plugin.added, ... are activity-irrelevant.
        _ => None,
    }
}

/// #604: count of detected stream-vocabulary drift contradictions since
/// boot (REST-observed status transition with no recognized stream
/// counterpart, or a pending ask listed by /permission|/question that
/// never appeared as an *.asked stream event). Read by
/// GET /api/server-info.
pub static OPENCODE_DRIFT_EVENTS: AtomicU64 = AtomicU64::new(0);

/// #604 drift rule (a) — transition contradiction. SessionStatus.set
/// publishes session.status/session.idle UNCONDITIONALLY on every
/// transition (opencode v1.18.14 status.ts:41-43), so a transition seen
/// by diffing two consecutive REST observations on a healthy stream
/// with zero recognized events in between is machine-proof of drift.
/// Steady state across a silent window (e.g. one long tool call that
/// publishes only message.part.updated, which translates to None) is
/// NOT drift — the falsified draft rule is deliberately not built.
pub fn drift_contradiction(
    previous_busy: Option<bool>,
    busy_in_snapshot: bool,
    recognized_since_verify: u64,
) -> bool {
    match previous_busy {
        Some(previous) => previous != busy_in_snapshot && recognized_since_verify == 0,
        None => false, // first observation on this stream: nothing to diff
    }
}

/// #604 drift rule (b) — asked-listing contradiction predicate: pending
/// ask ids fetched from GET /permission + GET /question that were never
/// seen as an *.asked stream event nor replayed at connect. Wired by
/// Task 8's mid-stream pending resync (which owns the fetches).
pub fn unseen_pending_asks(
    listed: &[(String, String)],
    known: &std::collections::HashSet<String>,
) -> Vec<String> {
    listed
        .iter()
        .filter(|(_, id)| !known.contains(id))
        .map(|(_, id)| id.clone())
        .collect()
}

// ── production impls (reqwest; wired at boot by Task 10) ────────────────────

/// Production [`OpencodeLaneHttp`]: `GET url` with the 2s per-request timeout
/// (the loopback serve's AbortController analog — DEV-0001), JSON body.
/// Constructed by `freshell-server`'s boot wiring (Task 10).
pub struct ReqwestLaneHttp(reqwest::Client);

impl ReqwestLaneHttp {
    pub fn new() -> Self {
        // Loopback plain-HTTP only; a plain client never fails to build.
        Self(
            reqwest::Client::builder()
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        )
    }
}

impl Default for ReqwestLaneHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl OpencodeLaneHttp for ReqwestLaneHttp {
    fn get_json<'a>(
        &'a self,
        url: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<(u16, serde_json::Value), String>> {
        Box::pin(async move {
            let response = self
                .0
                .get(url)
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            let body = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            Ok((status, body))
        })
    }
}

/// Production [`OpencodeEventStream`]: GET `{base}/event` with
/// `accept: text/event-stream`, then a chunk loop with the
/// [`OPENCODE_READ_STALL_MS`] per-chunk read-stall watchdog (heartbeats
/// arrive every ~10s) and a byte pending-buffer for partial UTF-8 — the
/// shape of `freshell_opencode::transport::consume_events:145-198`, WITHOUT
/// its internal reconnect loop (the lane owns cycles).
/// Constructed by `freshell-server`'s boot wiring (Task 10).
pub struct ReqwestLaneStream(reqwest::Client);

impl ReqwestLaneStream {
    pub fn new() -> Self {
        Self(
            reqwest::Client::builder()
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        )
    }
}

impl Default for ReqwestLaneStream {
    fn default() -> Self {
        Self::new()
    }
}

impl OpencodeEventStream for ReqwestLaneStream {
    fn connect<'a>(
        &'a self,
        url: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<Box<dyn ConnectedOpencodeStream>, String>> {
        Box::pin(async move {
            // Bound the request send like a stalled chunk read. The SSE GET
            // carries NO reqwest per-request timeout — that would kill the
            // long-lived stream body; the per-chunk watchdog covers reads.
            let response = tokio::time::timeout(
                Duration::from_millis(OPENCODE_READ_STALL_MS),
                self.0.get(url).header("accept", "text/event-stream").send(),
            )
            .await
            .map_err(|_| "opencode /event connect stalled".to_string())?
            .map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("GET /event returned {}", response.status()));
            }
            let mut inner = RawSseStream {
                response,
                decoder: RawSseDecoder::default(),
                pending: Vec::new(),
            };
            // Two-phase connect: read until the FIRST raw `server.connected`
            // frame — the subscription ack `parse_serve_event` swallows —
            // buffering any frames decoded past it, in order.
            let mut buffered: Vec<ParsedServeEvent> = Vec::new();
            loop {
                let values = inner
                    .next_raw_events()
                    .await?
                    .ok_or_else(|| "stream ended before the server.connected ack".to_string())?;
                let mut acked = false;
                for value in values {
                    if !acked
                        && value.get("type").and_then(|t| t.as_str()) == Some("server.connected")
                    {
                        // The ack itself is control-plane, never forwarded.
                        acked = true;
                        continue;
                    }
                    if acked {
                        if let Some(parsed) = parse_serve_event(&value) {
                            buffered.push(parsed);
                        }
                    }
                    // Pre-ack non-ack frames cannot exist (server.connected
                    // is the serve's first frame; opencode 1.18.11) — dropped
                    // defensively rather than mis-ordered around the snapshot.
                }
                if acked {
                    return Ok(Box::new(ReqwestConnectedStream { inner, buffered })
                        as Box<dyn ConnectedOpencodeStream>);
                }
            }
        })
    }
}

/// The reqwest `/event` body + raw decode state (pre-`parse_serve_event`).
struct RawSseStream {
    response: reqwest::Response,
    decoder: RawSseDecoder,
    /// Partial trailing UTF-8 scalar held for the next chunk
    /// (`TextDecoder{stream:true}` parity).
    pending: Vec<u8>,
}

impl RawSseStream {
    /// One watchdog-bounded chunk read, decoded to raw JSON event values.
    /// `Ok(None)` = clean stream end; `Err` = read stall or transport error.
    async fn next_raw_events(&mut self) -> Result<Option<Vec<serde_json::Value>>, String> {
        let chunk = tokio::time::timeout(
            Duration::from_millis(OPENCODE_READ_STALL_MS),
            self.response.chunk(),
        )
        .await
        .map_err(|_| "opencode /event read stalled".to_string())?
        .map_err(|e| e.to_string())?;
        let Some(bytes) = chunk else { return Ok(None) };
        self.pending.extend_from_slice(&bytes);
        // Decode the longest valid UTF-8 prefix, holding a partial trailing
        // scalar for the next chunk.
        let valid_up_to = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_up_to == 0 {
            return Ok(Some(Vec::new()));
        }
        let text = String::from_utf8_lossy(&self.pending[..valid_up_to]).into_owned();
        self.pending.drain(..valid_up_to);
        Ok(Some(self.decoder.push_str(&text)))
    }
}

/// SSE block decoder yielding RAW JSON values. Mirrors
/// `freshell_opencode::SseDecoder` block-for-block (CRLF-normalized `\n\n`
/// boundaries, `:` comments skipped, multi-line `data:` joined, malformed
/// frames skipped) but stops BEFORE `parse_serve_event` — the two-phase
/// connect must see `server.connected`, which parsing swallows.
#[derive(Default)]
struct RawSseDecoder {
    buf: String,
}

impl RawSseDecoder {
    fn push_str(&mut self, chunk: &str) -> Vec<serde_json::Value> {
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let mut out = Vec::new();
        while let Some(idx) = self.buf.find("\n\n") {
            let block = self.buf[..idx].to_string();
            self.buf.drain(..idx + 2);
            if let Some(value) = decode_raw_sse_block(&block) {
                out.push(value);
            }
        }
        out
    }
}

fn decode_raw_sse_block(block: &str) -> Option<serde_json::Value> {
    let mut data_lines: Vec<String> = Vec::new();
    for line in block.split('\n') {
        let trimmed = line.strip_suffix('\r').unwrap_or(line);
        if trimmed.is_empty() || trimmed.starts_with(':') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("data:") {
            data_lines.push(rest.trim_start().to_string());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    serde_json::from_str(&data_lines.join("\n")).ok()
}

/// The ack'd production stream: buffered frames first, then live.
struct ReqwestConnectedStream {
    inner: RawSseStream,
    /// Frames decoded past the subscription ack, awaiting the post-snapshot
    /// flush.
    buffered: Vec<ParsedServeEvent>,
}

impl ConnectedOpencodeStream for ReqwestConnectedStream {
    fn drive(
        mut self: Box<Self>,
        events_tx: tokio::sync::mpsc::UnboundedSender<ParsedServeEvent>,
    ) -> futures::future::BoxFuture<'static, Result<(), String>> {
        Box::pin(async move {
            // Buffered frames FIRST, in order — the loss-free flush that
            // happens after the lane noted its snapshot.
            for event in std::mem::take(&mut self.buffered) {
                if events_tx.send(event).is_err() {
                    return Ok(());
                }
            }
            loop {
                match self.inner.next_raw_events().await {
                    Ok(Some(values)) => {
                        for value in values {
                            if let Some(parsed) = parse_serve_event(&value) {
                                if events_tx.send(parsed).is_err() {
                                    return Ok(());
                                }
                            }
                        }
                    }
                    // Clean stream end → the lane reconnects at base backoff.
                    Ok(None) => return Ok(()),
                    // Read stall / transport error → backed-off reconnect.
                    Err(error) => return Err(error),
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use freshell_activity::opencode::OpencodeStatus;
    use freshell_opencode::{parse_serve_event, ParsedServeEvent, SseDecoder};
    use serde_json::json;

    use super::*;
    use crate::activity::{ActivityHub, OpencodeLaneEvent};

    // ── injected fakes (modeled on freshell-opencode/tests/
    //    serve_health_bounded.rs FakeHttp/FakeAllocator) ──────────────────

    /// Shared call-order log across BOTH fakes so tests can assert
    /// cross-seam ordering (connect vs the `/session/status` GET).
    type CallLog = Arc<Mutex<Vec<String>>>;

    type HttpResponder =
        Box<dyn Fn(&str) -> Result<(u16, serde_json::Value), String> + Send + Sync>;

    struct FakeLaneHttp {
        log: CallLog,
        respond: HttpResponder,
    }

    impl OpencodeLaneHttp for FakeLaneHttp {
        fn get_json<'a>(
            &'a self,
            url: &'a str,
        ) -> futures::future::BoxFuture<'a, Result<(u16, serde_json::Value), String>> {
            Box::pin(async move {
                self.log
                    .lock()
                    .expect("call log")
                    .push(format!("GET {url}"));
                (self.respond)(url)
            })
        }
    }

    /// One scripted connection: buffered frames (decoded past the
    /// subscription ack, flushed by `drive` FIRST), then live frames.
    /// `finish == true` → `drive` returns `Ok(())` after sending (clean
    /// stream end → the lane reconnects); `false` → `drive` parks forever
    /// (the cycle stays open, so every stamp stays at this cycle/stream).
    struct StreamScript {
        buffered: Vec<ParsedServeEvent>,
        live: Vec<ParsedServeEvent>,
        finish: bool,
    }

    struct FakeLaneStream {
        log: CallLog,
        scripts: Mutex<VecDeque<StreamScript>>,
    }

    impl OpencodeEventStream for FakeLaneStream {
        fn connect<'a>(
            &'a self,
            url: &'a str,
        ) -> futures::future::BoxFuture<'a, Result<Box<dyn ConnectedOpencodeStream>, String>>
        {
            Box::pin(async move {
                self.log
                    .lock()
                    .expect("call log")
                    .push(format!("CONNECT {url}"));
                let script = self.scripts.lock().expect("scripts").pop_front();
                match script {
                    Some(script) => {
                        Ok(Box::new(FakeConnected { script }) as Box<dyn ConnectedOpencodeStream>)
                    }
                    // Out of scripted cycles: park so the lane goes quiet
                    // instead of looping through unscripted reconnects.
                    None => {
                        std::future::pending::<()>().await;
                        unreachable!()
                    }
                }
            })
        }
    }

    struct FakeConnected {
        script: StreamScript,
    }

    impl ConnectedOpencodeStream for FakeConnected {
        fn drive(
            self: Box<Self>,
            events_tx: tokio::sync::mpsc::UnboundedSender<ParsedServeEvent>,
        ) -> futures::future::BoxFuture<'static, Result<(), String>> {
            Box::pin(async move {
                for event in self.script.buffered {
                    let _ = events_tx.send(event);
                }
                for event in self.script.live {
                    let _ = events_tx.send(event);
                }
                if self.script.finish {
                    Ok(())
                } else {
                    std::future::pending::<()>().await;
                    unreachable!()
                }
            })
        }
    }

    fn parsed(value: serde_json::Value) -> ParsedServeEvent {
        parse_serve_event(&value).expect("parseable serve event")
    }

    fn hub() -> (ActivityHub, tokio::sync::broadcast::Receiver<String>) {
        let (broadcast_tx, rx) = tokio::sync::broadcast::channel::<String>(256);
        (ActivityHub::new(Arc::new(broadcast_tx), None), rx)
    }

    /// Poll the hub's test-only send-side lane-ingress log until it holds at
    /// least `min_len` entries (or panic on timeout).
    async fn wait_for_ingress(
        hub: &ActivityHub,
        min_len: usize,
        timeout_ms: u64,
    ) -> Vec<(u64, u64, u64, OpencodeLaneEvent)> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let log = hub.lane_ingress_log();
            if log.len() >= min_len {
                return log;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "ingress log never reached {min_len} entries, got {log:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Wait for the first frame of `wanted` type that also satisfies `pred`
    /// (same helper shape as activity.rs's tests).
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

    // ── the tests ────────────────────────────────────────────────────────

    /// Verbatim spike vocabulary through the REAL decoder chain
    /// (`SseDecoder` → `parse_serve_event` → `translate_serve_event`):
    /// every attention-relevant kind maps to its lane event, and the
    /// activity-irrelevant kinds map to `None`.
    #[test]
    fn translate_covers_the_attention_vocabulary() {
        let frames = [
            json!({"type":"session.status","properties":{"sessionID":"ses-1","status":{"type":"busy"}}}),
            json!({"type":"session.status","properties":{"sessionID":"ses-1","status":{"type":"idle"}}}),
            json!({"type":"session.status","properties":{"sessionID":"ses-1","status":{"type":"retry"}}}),
            json!({"type":"session.idle","properties":{"sessionID":"ses-1"}}),
            json!({"type":"session.error","properties":{"sessionID":"ses-1","error":{"name":"MessageAbortedError","data":{"message":"aborted"}}}}),
            json!({"type":"session.error","properties":{"sessionID":"ses-1","error":{"data":{"message":"boom"}}}}),
            json!({"type":"permission.asked","properties":{"sessionID":"ses-1","id":"perm-1"}}),
            json!({"type":"permission.replied","properties":{"sessionID":"ses-1","requestID":"perm-1"}}),
            json!({"type":"session.created","properties":{"info":{"id":"ses-child","parentID":"ses-root"}}}),
            json!({"type":"session.created","properties":{"info":{"id":"ses-root"}}}),
            // W2 abort marker: message.updated WITH info.error.name ===
            // "MessageAbortedError" is the second abort signal (D1).
            json!({"type":"message.updated","properties":{"sessionID":"ses-1","info":{"sessionID":"ses-1","error":{"name":"MessageAbortedError"}}}}),
            // Error-less message.updated is routine message churn.
            json!({"type":"message.updated","properties":{"sessionID":"ses-1","info":{"sessionID":"ses-1"}}}),
            json!({"type":"message.part.delta","properties":{"part":{"sessionID":"ses-1"},"delta":"hi"}}),
            json!({"type":"session.diff","properties":{"sessionID":"ses-1","diff":[]}}),
            // #604: v1 + v2 + question families — source-verified against
            // opencode v1.18.14 (2026-08-06). TUI-driven turns emit the
            // V1 names (the TUI's own pause footer matches them); the v2
            // names fire only via the /api/* routes and are covered as
            // forward-compat. The /event stream applies NO type
            // transform, so whichever family the driving surface uses
            // arrives raw.
            json!({"type":"permission.v2.asked","properties":{"sessionID":"ses-1","id":"per-2","action":"bash","resources":["*"]}}),
            json!({"type":"permission.v2.replied","properties":{"sessionID":"ses-1","requestID":"per-2","reply":"once"}}),
            json!({"type":"question.asked","properties":{"sessionID":"ses-1","id":"que-1","questions":[{"question":"Proceed?","header":"Confirm","options":[]}]}}),
            json!({"type":"question.replied","properties":{"sessionID":"ses-1","requestID":"que-1","answers":[["yes"]]}}),
            json!({"type":"question.v2.asked","properties":{"sessionID":"ses-1","id":"que-2","questions":[{"question":"Proceed?","header":"Confirm","options":[]}]}}),
            json!({"type":"question.v2.rejected","properties":{"sessionID":"ses-1","requestID":"que-2"}}),
            json!({"type":"question.rejected","properties":{"sessionID":"ses-1","requestID":"que-1"}}),
            json!({"type":"question.v2.replied","properties":{"sessionID":"ses-1","requestID":"que-2","answers":[[]]}}),
            // There is NO permission.rejected / permission.v2.rejected
            // event type (v1/permission.ts:68, schema/permission.ts:52):
            // permission rejection IS a replied with reply:"reject" —
            // pinned so nobody ever "adds" a rejected row and waits on it.
            json!({"type":"permission.replied","properties":{"sessionID":"ses-1","requestID":"per-1","reply":"reject"}}),
        ];
        let stream: String = frames.iter().map(|f| format!("data: {f}\n\n")).collect();
        let mut decoder = SseDecoder::new();
        let events = decoder.push_str(&stream);
        assert_eq!(
            events.len(),
            frames.len(),
            "every frame decodes: {events:?}"
        );

        let translated: Vec<Option<OpencodeLaneEvent>> =
            events.iter().map(translate_serve_event).collect();
        assert_eq!(
            translated[0],
            Some(OpencodeLaneEvent::Status {
                session_id: "ses-1".into(),
                status: OpencodeStatus::Busy
            })
        );
        assert_eq!(
            translated[1],
            Some(OpencodeLaneEvent::Status {
                session_id: "ses-1".into(),
                status: OpencodeStatus::Idle
            })
        );
        assert_eq!(
            translated[2],
            Some(OpencodeLaneEvent::Status {
                session_id: "ses-1".into(),
                status: OpencodeStatus::Retry
            })
        );
        assert_eq!(
            translated[3],
            Some(OpencodeLaneEvent::SessionIdle {
                session_id: "ses-1".into()
            })
        );
        assert_eq!(
            translated[4],
            Some(OpencodeLaneEvent::SessionError {
                session_id: "ses-1".into(),
                error_name: "MessageAbortedError".into()
            })
        );
        assert_eq!(
            translated[5],
            Some(OpencodeLaneEvent::SessionError {
                session_id: "ses-1".into(),
                error_name: "UnknownError".into()
            }),
            "a session.error without error.name falls back to UnknownError"
        );
        assert_eq!(
            translated[6],
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-1".into(),
                permission_id: "perm-1".into()
            })
        );
        assert_eq!(
            translated[7],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "perm-1".into()
            })
        );
        assert_eq!(
            translated[8],
            Some(OpencodeLaneEvent::SessionCreated {
                session_id: "ses-child".into(),
                parent_id: Some("ses-root".into())
            })
        );
        assert_eq!(
            translated[9],
            Some(OpencodeLaneEvent::SessionCreated {
                session_id: "ses-root".into(),
                parent_id: None
            })
        );
        assert_eq!(
            translated[10],
            Some(OpencodeLaneEvent::SessionError {
                session_id: "ses-1".into(),
                error_name: "MessageAbortedError".into()
            }),
            "the W2 abort marker feeds the same SessionError lane event (D1)"
        );
        assert_eq!(
            translated[11], None,
            "error-less message.updated is routine churn"
        );
        assert_eq!(
            translated[12], None,
            "message.part.delta is activity-irrelevant"
        );
        assert_eq!(translated[13], None, "session.diff is activity-irrelevant");
        assert_eq!(
            translated[14],
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-1".to_string(),
                permission_id: "per-2".to_string(),
            }),
            "permission.v2.asked keeps id/sessionID — one reducer, two families"
        );
        assert_eq!(
            translated[15],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "per-2".to_string(),
            })
        );
        assert_eq!(
            translated[16],
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-1".to_string(),
                permission_id: "que-1".to_string(),
            }),
            "question.asked is a blocker identically to permission.asked (opencode's own TUI treats it so)"
        );
        assert_eq!(
            translated[17],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "que-1".to_string(),
            })
        );
        assert_eq!(
            translated[18],
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-1".to_string(),
                permission_id: "que-2".to_string(),
            })
        );
        assert_eq!(
            translated[19],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "que-2".to_string(),
            }),
            "a rejected question ends the pause exactly like a reply"
        );
        assert_eq!(
            translated[20],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "que-1".to_string(),
            })
        );
        assert_eq!(
            translated[21],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "que-2".to_string(),
            })
        );
        assert_eq!(
            translated[22],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "per-1".to_string(),
            }),
            "rejection IS a replied with reply:\"reject\" — no permission.*.rejected type exists (source-verified v1.18.14); the drain must not wait for one"
        );
    }

    /// Pure prefix check against `TESTED_OPENCODE_VERSION_RANGE`: "1.18.11"
    /// passes; "1.19.0" and "2.0.0" fail (the lane logs once and keeps
    /// bells on).
    #[test]
    fn version_gate_matches_only_the_tested_range() {
        assert!(version_in_tested_range("1.18.11"));
        assert!(!version_in_tested_range("1.19.0"));
        assert!(!version_in_tested_range("2.0.0"));
    }

    /// Name-reliability Task 4: a naming store that refuses (lock busy) the
    /// next `fail` observations, recording every attempt and every accepted
    /// title. Only `observe_native` is exercised.
    #[derive(Default)]
    struct TitleSink {
        fail: AtomicUsize,
        attempts: Mutex<Vec<String>>,
        accepted: Mutex<Vec<String>>,
    }

    impl freshell_freshagent::naming::SessionNaming for TitleSink {
        fn get(
            &self,
            _refs: Vec<freshell_protocol::SessionNameRef>,
        ) -> freshell_freshagent::naming::NameFuture<Vec<freshell_protocol::SessionNameUpdate>>
        {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn ensure_pending(
            &self,
            _input: freshell_freshagent::naming::PendingNameInput,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
        fn bind_pending(
            &self,
            _input: freshell_freshagent::naming::BindNameInput,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
        fn rename(
            &self,
            _input: freshell_freshagent::naming::RenameNameInput,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
        fn activity(
            &self,
            _input: freshell_freshagent::naming::NameActivity,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
        fn observe_native(
            &self,
            input: freshell_freshagent::naming::NativeNameObservation,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            self.attempts.lock().unwrap().push(input.title.clone());
            let refuse = self
                .fail
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok();
            if refuse {
                return Box::pin(async {
                    Err(freshell_freshagent::naming::NameError::LockUnavailable(
                        "injected: the document lock stayed busy".into(),
                    ))
                });
            }
            self.accepted.lock().unwrap().push(input.title.clone());
            let record = freshell_protocol::session_names::SessionNameRecord {
                name_ref: input.target,
                name: input.title,
                source: freshell_protocol::session_names::NameSource::ProviderAi,
                revision: 2,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            };
            Box::pin(async move {
                Ok(freshell_protocol::SessionNameUpdate {
                    record,
                    document_generation: 2,
                    redirects: Vec::new(),
                    changed: true,
                    native_sync: None,
                    outcome: None,
                })
            })
        }
        fn record_acquisition(
            &self,
            _target: freshell_protocol::SessionNameRef,
            _acquisition: freshell_protocol::native_location::NativeAcquisition,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
    }

    /// Name-reliability Task 4 (the CLI lane's `NativeTitleObserver` seam
    /// that `main.rs` wires): `session.updated` titles fold through the
    /// naming store without ever stalling the lane. The placeholder never
    /// reaches the store, the real title's locked inline attempt hands off
    /// to the background retry, and the event after the titles reaches the
    /// hub at once.
    #[tokio::test(flavor = "multi_thread")]
    async fn naming_title_observer_folds_titles_without_stalling_the_lane() {
        let sink = Arc::new(TitleSink::default());
        sink.fail.store(1, Ordering::SeqCst);
        let observer = crate::opencode_title_naming::naming_title_observer(
            crate::identity::TerminalIdentityRegistry::new(),
            Some(sink.clone() as Arc<dyn freshell_freshagent::naming::SessionNaming>),
        );
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = Arc::new(FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                Ok((404, json!({})))
            }),
        });
        let stream = Arc::new(FakeLaneStream {
            log,
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![
                    parsed(json!({
                        "type": "session.updated",
                        "properties": { "info": {
                            "id": "ses-title",
                            "title": "New session - 2026-10-20T00:09:25.350Z"
                        } }
                    })),
                    parsed(json!({
                        "type": "session.updated",
                        "properties": { "info": {
                            "id": "ses-title",
                            "title": "Publishing blocked by token error"
                        } }
                    })),
                    parsed(json!({
                        "type": "session.idle",
                        "properties": { "sessionID": "ses-title" }
                    })),
                ],
                finish: false,
            }])),
        });
        let deps = Arc::new(OpencodeLaneDeps {
            http,
            events: stream,
            native_title_observer: Some(observer),
        });
        let (hub, _rx) = hub();
        (hub.registry_observer())(freshell_terminal::ActivityEvent::Created {
            terminal_id: "t-title".into(),
            mode: "opencode".into(),
            resume_session_id: Some("ses-title".into()),
            at: 1_000,
        });
        hub.register_opencode_lane_for_tests("t-title", 1);
        let (_lane, _verify_tx) =
            spawn_opencode_lane(deps, hub.clone(), "t-title".into(), "http://fake".into(), 1);

        // Snapshot, then the idle that followed both titles — promptly.
        let ingress = wait_for_ingress(&hub, 2, 1_000).await;
        assert!(
            matches!(
                ingress[1].3,
                OpencodeLaneEvent::SessionIdle { ref session_id } if session_id == "ses-title"
            ),
            "{ingress:?}"
        );

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while sink.accepted.lock().unwrap().is_empty() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the background retry never folded the real title: {:?}",
                sink.attempts.lock().unwrap()
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(
            sink.accepted.lock().unwrap().clone(),
            vec!["Publishing blocked by token error".to_string()]
        );
        assert!(
            !sink
                .attempts
                .lock()
                .unwrap()
                .iter()
                .any(|title| title.starts_with("New session - ")),
            "the placeholder never reached the store"
        );
    }

    /// The cycle shape: health gate (two 500s, then healthy) → two-phase
    /// connect → `/session/status` snapshot → buffered-frame flush. The
    /// snapshot is noted BEFORE the buffered `session.idle`, connect
    /// precedes the snapshot GET, and every ingress event is stamped
    /// (generation 1, cycle 1, stream 1).
    #[tokio::test(flavor = "multi_thread")]
    async fn lane_gates_on_health_then_snapshots_then_streams() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let health_calls = Arc::new(AtomicUsize::new(0));
        let health_calls_resp = health_calls.clone();
        let http = Arc::new(FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    let n = health_calls_resp.fetch_add(1, Ordering::SeqCst) + 1;
                    if n <= 2 {
                        return Ok((500, json!({})));
                    }
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({ "ses-r": { "type": "busy" } })));
                }
                // Root-resolver probes 404: the conservative forward-anyway
                // path (retried on the next unknown-id occurrence).
                Ok((404, json!({})))
            }),
        });
        let stream = Arc::new(FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![parsed(
                    json!({"type":"session.idle","properties":{"sessionID":"ses-r"}}),
                )],
                live: vec![],
                finish: false, // keep cycle 1 open: all stamps stay (1, 1)
            }])),
        });
        let deps = Arc::new(OpencodeLaneDeps {
            http,
            events: stream,
            native_title_observer: None,
        });

        let (hub, mut rx) = hub();
        // A tracked opencode terminal resumed on the root identity, so the
        // snapshot's busy edge and the idle edge flow end-to-end to the wire.
        (hub.registry_observer())(freshell_terminal::ActivityEvent::Created {
            terminal_id: "t-oc".into(),
            mode: "opencode".into(),
            resume_session_id: Some("ses-r".into()),
            at: 1_000,
        });
        hub.register_opencode_lane_for_tests("t-oc", 1);
        let (lane, _verify_tx) =
            spawn_opencode_lane(deps, hub.clone(), "t-oc".into(), "http://fake".into(), 1);

        // Ingress order + stamping: Snapshot BEFORE the buffered
        // SessionIdle, all (generation 1, cycle 1, stream 1).
        let ingress = wait_for_ingress(&hub, 2, 5_000).await;
        assert_eq!(
            ingress[0],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::Snapshot {
                    statuses: vec![("ses-r".into(), OpencodeStatus::Busy)]
                }
            )
        );
        assert_eq!(
            ingress[1],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::SessionIdle {
                    session_id: "ses-r".into()
                }
            )
        );

        // Call order: three health probes gate the cycle, and connect
        // precedes the snapshot GET (the two-phase, loss-free ordering).
        let calls = log.lock().expect("call log").clone();
        let connect_at = calls
            .iter()
            .position(|c| c == "CONNECT http://fake/event")
            .expect("connect happened");
        let snapshot_at = calls
            .iter()
            .position(|c| c == "GET http://fake/session/status")
            .expect("snapshot GET happened");
        assert!(
            connect_at < snapshot_at,
            "two-phase connect must precede the snapshot: {calls:?}"
        );
        assert_eq!(
            calls[..connect_at]
                .iter()
                .filter(|c| *c == "GET http://fake/global/health")
                .count(),
            3,
            "health gated the cycle (two 500s then healthy): {calls:?}"
        );

        // End-to-end wire evidence: the events passed the REAL generation
        // guard — busy upsert from the snapshot, then the idle edge's
        // turn.complete.
        let busy = next_frame_matching(&mut rx, "opencode.activity.updated", 5_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("snapshot busy upsert on the wire");
        assert_eq!(busy["upsert"][0]["terminalId"], "t-oc");
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 5_000, |_| true)
            .await
            .expect("the buffered idle edge completes the turn");
        assert_eq!(complete["provider"], "opencode");
        assert_eq!(complete["terminalId"], "t-oc");

        lane.abort();
    }

    /// Every reconnect is a fresh cycle AND a fresh stream: two clean
    /// streamed cycles note two snapshots stamped (cycle 1, stream 1) then
    /// (cycle 2, stream 2), each after its own connect.
    #[tokio::test(flavor = "multi_thread")]
    async fn reconnect_bumps_stream_and_resnapshots() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = Arc::new(FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                Ok((404, json!({})))
            }),
        });
        let clean_cycle = || StreamScript {
            buffered: vec![],
            live: vec![],
            finish: true, // drive returns Ok(()) immediately → reconnect
        };
        let stream = Arc::new(FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([clean_cycle(), clean_cycle()])),
        });
        let deps = Arc::new(OpencodeLaneDeps {
            http,
            events: stream,
            native_title_observer: None,
        });

        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t-oc", 1);
        let (lane, _verify_tx) =
            spawn_opencode_lane(deps, hub.clone(), "t-oc".into(), "http://fake".into(), 1);

        let ingress = wait_for_ingress(&hub, 2, 5_000).await;
        assert_eq!(
            ingress[0],
            (1, 1, 1, OpencodeLaneEvent::Snapshot { statuses: vec![] })
        );
        assert_eq!(
            ingress[1],
            (1, 2, 2, OpencodeLaneEvent::Snapshot { statuses: vec![] }),
            "the reconnect bumps BOTH cycle and stream"
        );

        // Each snapshot was noted after its own connect: the call order is
        // health → connect → snapshot GET → permission GET → question GET,
        // twice (#608: the pending-ask resync runs between the snapshot
        // fetch and the Snapshot note; here both asks GETs 404 → the
        // resync warns and continues).
        let calls = log.lock().expect("call log").clone();
        assert_eq!(
            &calls[..10],
            &[
                "GET http://fake/global/health".to_string(),
                "CONNECT http://fake/event".to_string(),
                "GET http://fake/session/status".to_string(),
                "GET http://fake/permission".to_string(),
                "GET http://fake/question".to_string(),
                "GET http://fake/global/health".to_string(),
                "CONNECT http://fake/event".to_string(),
                "GET http://fake/session/status".to_string(),
                "GET http://fake/permission".to_string(),
                "GET http://fake/question".to_string(),
            ],
            "full order: {calls:?}"
        );

        lane.abort();
    }

    /// D8(c): a streamed event for a session unseen on-stream triggers the
    /// HTTP root resolver, which announces the parent chain (deepest
    /// ancestor first) BEFORE the triggering event; resolver failure
    /// forwards the event anyway (conservative ambiguity stands, retried on
    /// the next occurrence).
    #[tokio::test(flavor = "multi_thread")]
    async fn unmapped_session_is_resolved_via_http_before_forwarding() {
        // ── success: the parentID chain lands root-first, then the event ──
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = Arc::new(FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                if url.ends_with("/session/ses-child") {
                    return Ok((200, json!({ "id": "ses-child", "parentID": "ses-root" })));
                }
                if url.ends_with("/session/ses-root") {
                    return Ok((200, json!({ "id": "ses-root" })));
                }
                Ok((404, json!({})))
            }),
        });
        let stream = Arc::new(FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![parsed(
                    json!({"type":"session.status","properties":{"sessionID":"ses-child","status":{"type":"busy"}}}),
                )],
                finish: false,
            }])),
        });
        let deps = Arc::new(OpencodeLaneDeps {
            http,
            events: stream,
            native_title_observer: None,
        });

        let (hub_ok, _rx) = hub();
        hub_ok.register_opencode_lane_for_tests("t-oc", 1);
        let (lane, _verify_tx) =
            spawn_opencode_lane(deps, hub_ok.clone(), "t-oc".into(), "http://fake".into(), 1);

        let ingress = wait_for_ingress(&hub_ok, 4, 5_000).await;
        assert_eq!(
            ingress[0].3,
            OpencodeLaneEvent::Snapshot { statuses: vec![] }
        );
        assert_eq!(
            ingress[1],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::SessionCreated {
                    session_id: "ses-root".into(),
                    parent_id: None
                }
            ),
            "the deepest unknown ancestor is announced FIRST"
        );
        assert_eq!(
            ingress[2],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::SessionCreated {
                    session_id: "ses-child".into(),
                    parent_id: Some("ses-root".into())
                }
            )
        );
        assert_eq!(
            ingress[3],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::Status {
                    session_id: "ses-child".into(),
                    status: OpencodeStatus::Busy
                }
            ),
            "the triggering event lands AFTER the synthetic chain"
        );
        lane.abort();

        // ── failure: 404 on GET /session/{id} → the Status is forwarded
        //    anyway, with NO synthetic SessionCreated ──
        let log_fail: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http_fail = Arc::new(FakeLaneHttp {
            log: log_fail.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                Ok((404, json!({})))
            }),
        });
        let stream_fail = Arc::new(FakeLaneStream {
            log: log_fail.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![parsed(
                    json!({"type":"session.status","properties":{"sessionID":"ses-child","status":{"type":"busy"}}}),
                )],
                finish: false,
            }])),
        });
        let deps_fail = Arc::new(OpencodeLaneDeps {
            http: http_fail,
            events: stream_fail,
            native_title_observer: None,
        });

        let (hub_fail, _rx_fail) = hub();
        hub_fail.register_opencode_lane_for_tests("t-oc", 1);
        let (lane_fail, _verify_tx_fail) = spawn_opencode_lane(
            deps_fail,
            hub_fail.clone(),
            "t-oc".into(),
            "http://fake".into(),
            1,
        );

        let ingress = wait_for_ingress(&hub_fail, 2, 5_000).await;
        assert_eq!(
            ingress[1],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::Status {
                    session_id: "ses-child".into(),
                    status: OpencodeStatus::Busy
                }
            ),
            "resolve failure still forwards the triggering event"
        );
        assert!(
            !ingress
                .iter()
                .any(|(_, _, _, e)| matches!(e, OpencodeLaneEvent::SessionCreated { .. })),
            "no synthetic SessionCreated on resolver failure: {ingress:?}"
        );
        // The resolver WAS attempted (and will retry on the next occurrence).
        assert!(
            log_fail
                .lock()
                .expect("call log")
                .iter()
                .any(|c| c == "GET http://fake/session/ses-child"),
            "the resolver probe was attempted"
        );
        lane_fail.abort();
    }

    /// #603: a verify request makes the lane re-fetch /session/status and
    /// note the result with the CURRENT cycle/stream stamps (so the
    /// tracker's sameSessionStream guards accept it); a failing probe
    /// notes SnapshotFailed instead of anything idle-shaped.
    #[tokio::test(flavor = "multi_thread")]
    async fn verify_request_refetches_snapshot_with_current_stamps() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_calls_in_responder = snapshot_calls.clone();
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/session/status") {
                    let n = snapshot_calls_in_responder.fetch_add(1, Ordering::SeqCst);
                    if n <= 1 {
                        // connect snapshot + first verify: busy
                        return Ok((200, json!({"ses-1": {"type": "busy"}})));
                    }
                    // second verify: probe failure
                    return Err("connection refused".to_string());
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, json!({"id": "ses-1"})));
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // park: the cycle stays open
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );
        // Connect snapshot arrives first.
        let log1 = wait_for_ingress(&hub, 2, 2000).await; // SessionCreated + Snapshot
        let (gen0, cycle0, stream0, _) = log1[log1.len() - 1].clone();
        // Verify request → a SECOND /session/status GET, same stamps.
        verify_tx.send(()).expect("verify channel open");
        let log2 = wait_for_ingress(&hub, 3, 2000).await;
        let (gen1, cycle1, stream1, event1) = log2[log2.len() - 1].clone();
        assert_eq!((gen1, cycle1, stream1), (gen0, cycle0, stream0));
        assert_eq!(
            event1,
            OpencodeLaneEvent::Snapshot {
                statuses: vec![("ses-1".to_string(), OpencodeStatus::Busy)]
            }
        );
        // Second verify: the probe fails → SnapshotFailed, never idle.
        verify_tx.send(()).expect("verify channel open");
        let log3 = wait_for_ingress(&hub, 4, 2000).await;
        match &log3[log3.len() - 1].3 {
            OpencodeLaneEvent::SnapshotFailed { error } => {
                assert!(error.contains("connection refused"), "got: {error}");
            }
            other => panic!("expected SnapshotFailed, got {other:?}"),
        }
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 3);
        lane.abort();
    }

    /// #604: /session/status parse trouble must never read as "all idle".
    /// Unknown status VOCABULARY degrades toward busy; a SHAPE break is a
    /// probe failure (crash semantics downstream) — pinned both ways.
    #[tokio::test(flavor = "multi_thread")]
    async fn snapshot_unknown_vocabulary_is_busy_and_shape_break_is_failure() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_calls_in_responder = snapshot_calls.clone();
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/session/status") {
                    let n = snapshot_calls_in_responder.fetch_add(1, Ordering::SeqCst);
                    match n {
                        // Connect-cycle snapshot: empty
                        0 => return Ok((200, json!({}))),
                        // First verify: unknown vocabulary "hyperbusy" → Busy + warn
                        1 => return Ok((200, json!({"ses-1": {"type": "hyperbusy"}}))),
                        // Second verify: retry (named so the retrying-turn light can never drift idle)
                        2 => return Ok((200, json!({"ses-1": {"type": "retry"}}))),
                        // Third verify: shape break (not an object)
                        _ => return Ok((200, json!({"ses-1": 42}))),
                    }
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, json!({"id": "ses-1"})));
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // park: the cycle stays open for verify requests
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );
        // Connect snapshot arrives first (empty, no sessions).
        let log1 = wait_for_ingress(&hub, 1, 2000).await; // Snapshot (empty)
        let (gen0, cycle0, stream0, _) = log1[log1.len() - 1].clone();

        // First verify: unknown vocabulary "hyperbusy" → Busy + warn
        verify_tx.send(()).expect("verify channel open");
        let log2 = wait_for_ingress(&hub, 3, 2000).await; // SessionCreated + Snapshot
        let (gen1, cycle1, stream1, event1) = log2[log2.len() - 1].clone();
        assert_eq!((gen1, cycle1, stream1), (gen0, cycle0, stream0));
        assert_eq!(
            event1,
            OpencodeLaneEvent::Snapshot {
                statuses: vec![("ses-1".to_string(), OpencodeStatus::Busy)]
            },
            "unknown vocabulary 'hyperbusy' degrades to Busy"
        );

        // Second verify: retry (named so the retrying-turn light can never drift idle)
        verify_tx.send(()).expect("verify channel open");
        let log3 = wait_for_ingress(&hub, 4, 2000).await;
        let (gen2, cycle2, stream2, event2) = log3[log3.len() - 1].clone();
        assert_eq!((gen2, cycle2, stream2), (gen0, cycle0, stream0));
        assert_eq!(
            event2,
            OpencodeLaneEvent::Snapshot {
                statuses: vec![("ses-1".to_string(), OpencodeStatus::Retry)]
            },
            "retry is Busy everywhere (D6): the light stays on"
        );

        // Third verify: shape break (not an object) → SnapshotFailed
        verify_tx.send(()).expect("verify channel open");
        let log4 = wait_for_ingress(&hub, 5, 2000).await;
        match &log4[log4.len() - 1].3 {
            OpencodeLaneEvent::SnapshotFailed { error } => {
                assert!(
                    error.contains("not an object"),
                    "expected 'not an object' in error, got: {error}"
                );
            }
            other => panic!("expected SnapshotFailed, got {other:?}"),
        }
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 4);
        lane.abort();
    }

    #[test]
    fn drift_contradiction_rule() {
        // Rule (a): a REST-observed status TRANSITION with no recognized
        // stream counterpart is drift…
        assert!(drift_contradiction(Some(true), false, 0));
        assert!(drift_contradiction(Some(false), true, 0));
        // …a transition WITH recognized stream traffic is normal…
        assert!(!drift_contradiction(Some(true), false, 2));
        assert!(!drift_contradiction(Some(false), true, 1));
        // …and steady state across a silent window is a LONG TOOL CALL,
        // not drift (the falsified draft rule: message.part.updated
        // translates to None and session.status publishes on transitions
        // only — never flag busy==busy silence).
        assert!(!drift_contradiction(Some(true), true, 0));
        assert!(!drift_contradiction(Some(false), false, 0));
        // The first observation on a stream has no previous to diff.
        assert!(!drift_contradiction(None, true, 0));
        assert!(!drift_contradiction(None, false, 0));
    }

    #[test]
    fn unseen_pending_asks_rule() {
        // Rule (b): listed-but-never-asked ids are drift evidence; wiring
        // lands with Task 8's pending resync.
        let mut known = std::collections::HashSet::new();
        known.insert("per-1".to_string());
        let listed = vec![
            ("ses-1".to_string(), "per-1".to_string()),
            ("ses-1".to_string(), "que-9".to_string()),
        ];
        assert_eq!(
            unseen_pending_asks(&listed, &known),
            vec!["que-9".to_string()]
        );
        known.insert("que-9".to_string());
        assert!(unseen_pending_asks(&listed, &known).is_empty());
        assert!(unseen_pending_asks(&[], &known).is_empty());
    }

    /// #608: on (re)connect the lane asks GET /permission AND
    /// GET /question (disjoint pending stores, source-verified opencode
    /// v1.18.14) and replays outstanding asks into the tracker BEFORE
    /// the snapshot is noted, so an ask that happened during the SSE gap
    /// still arms the pause; a PermissionsSynced entry follows so the
    /// hub can drain stale local pauses.
    #[tokio::test(flavor = "multi_thread")]
    async fn connect_replays_outstanding_asks_before_snapshot() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/permission") {
                    return Ok((
                        200,
                        json!([{"id":"per-9","sessionID":"ses-1","permission":"bash",
                                "patterns":[],"metadata":{},"always":[]}]),
                    ));
                }
                if url.ends_with("/question") {
                    return Ok((
                        200,
                        json!([{"id":"que-3","sessionID":"ses-1","questions":[]}]),
                    ));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({"ses-1": {"type": "busy"}})));
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, json!({"id": "ses-1"})));
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // park: the cycle stays open
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, _verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );

        // SessionCreated + PermissionAsked x2 + PermissionsSynced + Snapshot.
        let ingress = wait_for_ingress(&hub, 5, 2000).await;
        let idx_of_per_asked = ingress
            .iter()
            .position(|(_, _, _, e)| {
                *e == OpencodeLaneEvent::PermissionAsked {
                    session_id: "ses-1".to_string(),
                    permission_id: "per-9".to_string(),
                }
            })
            .expect("per-9 replayed as PermissionAsked");
        let idx_of_que_asked = ingress
            .iter()
            .position(|(_, _, _, e)| {
                *e == OpencodeLaneEvent::PermissionAsked {
                    session_id: "ses-1".to_string(),
                    permission_id: "que-3".to_string(),
                }
            })
            .expect("que-3 replayed as PermissionAsked");
        let idx_of_synced = ingress
            .iter()
            .position(|(_, _, _, e)| {
                *e == OpencodeLaneEvent::PermissionsSynced {
                    pending_ids: vec!["per-9".to_string(), "que-3".to_string()],
                }
            })
            .expect("PermissionsSynced noted with both ids");
        let idx_of_snapshot = ingress
            .iter()
            .position(|(_, _, _, e)| matches!(e, OpencodeLaneEvent::Snapshot { .. }))
            .expect("snapshot noted");
        assert!(
            idx_of_per_asked < idx_of_synced && idx_of_que_asked < idx_of_synced,
            "replay must precede reconciliation"
        );
        assert!(
            idx_of_synced < idx_of_snapshot,
            "replay+sync must precede the snapshot"
        );
        // Every entry carries the same (generation, cycle, stream).
        for (generation, cycle, stream_id, _) in &ingress {
            assert_eq!((*generation, *cycle, *stream_id), (7, 1, 1));
        }
        lane.abort();
    }

    /// #608 mid-stream resync wires #604 rule (b): a pending ask id
    /// listed by /permission that was never seen as an *.asked stream
    /// event (nor replayed at connect) is drift — the counter bumps and
    /// the error logs once, but the pause STILL arms: the
    /// PermissionAsked + PermissionsSynced ingress pair arrives anyway.
    #[tokio::test(flavor = "multi_thread")]
    async fn verify_resync_flags_never_streamed_ask_as_drift() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let permission_calls = Arc::new(AtomicUsize::new(0));
        let permission_calls_in_responder = permission_calls.clone();
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/permission") {
                    let n = permission_calls_in_responder.fetch_add(1, Ordering::SeqCst);
                    if n == 0 {
                        // Connect-time resync: nothing pending.
                        return Ok((200, json!([])));
                    }
                    // Verify-time resync: a never-streamed pending ask.
                    return Ok((
                        200,
                        json!([{"id":"per-drift","sessionID":"ses-1","permission":"bash",
                                "patterns":[],"metadata":{},"always":[]}]),
                    ));
                }
                if url.ends_with("/question") {
                    return Ok((200, json!([])));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, json!({"id": "ses-1"})));
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // park: the cycle stays open for verify requests
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );

        // Connect completes: PermissionsSynced (empty) + Snapshot (empty).
        let log1 = wait_for_ingress(&hub, 2, 2000).await;
        assert_eq!(
            log1[0].3,
            OpencodeLaneEvent::PermissionsSynced {
                pending_ids: vec![]
            }
        );
        assert!(matches!(log1[1].3, OpencodeLaneEvent::Snapshot { .. }));

        // One verify against the drifted /permission listing.
        let drift_before = OPENCODE_DRIFT_EVENTS.load(AtomicOrdering::SeqCst);
        verify_tx.send(()).expect("verify channel open");
        // Verify Snapshot + SessionCreated + PermissionAsked +
        // PermissionsSynced.
        let ingress = wait_for_ingress(&hub, 6, 2000).await;
        assert!(
            OPENCODE_DRIFT_EVENTS.load(AtomicOrdering::SeqCst) > drift_before,
            "rule (b) drift increments the counter"
        );
        // The pause still arms even while drift is flagged.
        assert!(
            ingress.iter().any(|(_, _, _, e)| *e
                == OpencodeLaneEvent::PermissionAsked {
                    session_id: "ses-1".to_string(),
                    permission_id: "per-drift".to_string(),
                }),
            "the never-streamed ask is still replayed: {ingress:?}"
        );
        assert!(
            ingress.iter().any(|(_, _, _, e)| *e
                == OpencodeLaneEvent::PermissionsSynced {
                    pending_ids: vec!["per-drift".to_string()],
                }),
            "reconciliation still follows the replay: {ingress:?}"
        );
        lane.abort();
    }

    /// A failing CONNECT-cycle snapshot notes SnapshotFailed (loud, crash
    /// semantics) instead of silently backing off.
    #[tokio::test(flavor = "multi_thread")]
    async fn connect_snapshot_failure_is_noted() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/session/status") {
                    return Err("boom".to_string());
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // one parked stream
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, _verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );

        // The FIRST ingress entry should be SnapshotFailed (noting the failure
        // on the connect-cycle snapshot, loud crash semantics).
        let ingress = wait_for_ingress(&hub, 1, 2000).await;
        match &ingress[0].3 {
            OpencodeLaneEvent::SnapshotFailed { error } => {
                assert!(
                    error.contains("boom"),
                    "expected 'boom' in error, got: {error}"
                );
            }
            other => panic!("expected SnapshotFailed as first ingress, got {other:?}"),
        }
        lane.abort();
    }
}
