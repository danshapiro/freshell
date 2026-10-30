//! Task 9: the per-terminal opencode SSE lane — the transport-only event
//! pump between one pane's embedded `opencode serve` (loopback HTTP+SSE) and
//! the activity hub's generation-guarded ingress
//! sink. Policy lives in the pure
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

use crate::{parse_serve_event, ParsedServeEvent};
use freshell_activity::opencode::OpencodeStatus;

use freshell_activity::opencode::OpencodeLaneEvent;

pub const OPENCODE_HEALTH_POLL_MS: u64 = 200; // mirrors Node :18
pub const OPENCODE_HEALTH_TIMEOUT_MS: u64 = 15_000; // per cycle, Node :20
pub const OPENCODE_RECONNECT_BASE_MS: u64 = 250; // Node :21
pub const OPENCODE_RECONNECT_MAX_MS: u64 = 5_000; // Node :22
pub const OPENCODE_READ_STALL_MS: u64 = 30_000; // Node :24 (production stream impl)
/// Version drift gate (log-once per lane): prefix match against the REQUIRED
/// `version` field of GET /global/health (derives from opencode 1.18.11:
/// { healthy, version } are both required; session.idle is already deprecated
/// upstream and a v1->v2 event/health migration is in progress — D8(h)).
pub const TESTED_OPENCODE_VERSION_RANGE: &str = "1.18.";

/// `true` when `version` is inside the tested vocabulary range. Out-of-range
/// versions log ONCE per lane and keep bells on (best-effort; D8(h)).
pub fn version_in_tested_range(version: &str) -> bool {
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

/// A body-free native activity observation sink.
pub type ActivityLaneSink = Arc<dyn Fn(u64, u64, OpencodeLaneEvent) + Send + Sync>;

/// Admission acknowledgement: true only after an acknowledged subscription
/// and successful native snapshot. False on disconnect or lane cancellation.
pub type NativeSubscriptionObserver = Arc<dyn Fn(bool) + Send + Sync>;

/// Spawn the reusable native lane. Its owner supplies the generation-fenced
/// sink and owns cancellation; native cycle and stream stamps are preserved.
pub fn spawn_opencode_lane(
    deps: Arc<OpencodeLaneDeps>,
    sink: ActivityLaneSink,
    terminal_id: String,
    base_url: String,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedSender<()>,
) {
    spawn_opencode_lane_with_readiness(deps, sink, terminal_id, base_url, None)
}

pub fn spawn_opencode_lane_with_readiness(
    deps: Arc<OpencodeLaneDeps>,
    sink: ActivityLaneSink,
    terminal_id: String,
    base_url: String,
    subscription_observer: Option<NativeSubscriptionObserver>,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedSender<()>,
) {
    let (verify_tx, verify_rx) = tokio::sync::mpsc::unbounded_channel();
    let lane = Lane {
        deps,
        sink,
        terminal_id,
        base_url,
        subscription_observer,
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
    sink: ActivityLaneSink,
    terminal_id: String,
    base_url: String,
    subscription_observer: Option<NativeSubscriptionObserver>,
}

impl Drop for Lane {
    fn drop(&mut self) {
        self.subscription_ready(false);
    }
}

impl Lane {
    fn subscription_ready(&self, ready: bool) {
        if let Some(observer) = &self.subscription_observer {
            observer(ready);
        }
    }
    fn note(&self, cycle: u64, stream: u64, event: OpencodeLaneEvent) {
        (self.sink)(cycle, stream, event);
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
            self.subscription_ready(false);
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
                self.subscription_ready(true);

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
                                    crate::session_title_observation(&parsed)
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

            self.subscription_ready(false);

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
pub fn translate_serve_event(event: &ParsedServeEvent) -> Option<OpencodeLaneEvent> {
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
            let session_id = event.session_id.clone()?;
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
                .no_proxy()
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
/// shape of `crate::transport::consume_events:145-198`, WITHOUT
/// its internal reconnect loop (the lane owns cycles).
/// Constructed by `freshell-server`'s boot wiring (Task 10).
pub struct ReqwestLaneStream(reqwest::Client);

impl ReqwestLaneStream {
    pub fn new() -> Self {
        Self(
            reqwest::Client::builder()
                .no_proxy()
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
/// `crate::SseDecoder` block-for-block (CRLF-normalized `\n\n`
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
