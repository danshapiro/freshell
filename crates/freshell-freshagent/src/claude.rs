//! # freshell-freshagent :: claude — the freshclaude WS fresh-agent slice (Phase 3.9)
//!
//! The additive wiring that lets the equivalence oracle drive a live claude/Haiku T2
//! turn THROUGH the Rust server exactly as it drives the original, and prove
//! `original≡rust` at T2. A faithful port of the claude path of `server/ws-handler.ts`
//! (`freshAgent.create` / `freshAgent.send`) + `server/fresh-agent/adapters/claude/adapter.ts`
//! + `server/sdk-bridge.ts` — but the SDK itself (`@anthropic-ai/claude-agent-sdk`, which
//! has NO Rust equivalent) runs in the ONE sanctioned Node sidecar
//! (`crates/freshell-claude-sidecar`, ADR Decision 2), spoken over newline-JSON stdio.
//!
//! ## Drive path (WS, not REST) — mirrors the codex slice
//!
//! | Client→server | Behaviour |
//! |---|---|
//! | `freshAgent.create {sessionType:'freshclaude'\|'kilroy',…}` | spawn the Node sidecar (ownership-tagged, isolated HOME inherited) → SDK `query()` → the SDK bridge's **BARE nanoid** placeholder id (NO placeholder→durable materialization — claude's send returns void), broadcast `freshAgent.created`, start the stdout consumer |
//! | `freshAgent.send {sessionId,text}` | push the user turn into the sidecar's SDK input stream, broadcast `freshAgent.send.accepted` (NO `submittedTurnId` — claude) |
//!
//! ## Events + the completion edge
//!
//! The sidecar emits the SAME `sdk.*` shapes `SdkBridge` broadcasts. The stdout consumer
//! normalizes each `sdk.* → freshAgent.*` (a port of `server/fresh-agent/sdk-events.ts`)
//! and wraps it in a `freshAgent.event` envelope: `sdk.session.init` → `freshAgent.session.init`
//! (durable Claude UUID via `cliSessionId`), `sdk.stream`/`sdk.assistant`/`sdk.result`, and —
//! ONLY when the SDK `result` carries `subtype==='success'` — the discrete
//! `freshAgent.turn.complete` chime. That status-guarded edge is the T2
//! `provider.emits-completion-signal` invariant. The `.jsonl` transcript the claude CLI
//! persists under the isolated `<CLAUDE_HOME>/projects/…` corroborates it.
//!
//! ## New failure mode (ADR Decision 2.1) — sidecar death is completion-safe
//!
//! A `freshAgent.turn.complete` is broadcast ONLY on an explicit `sdk.turn.complete` from
//! the sidecar. If the sidecar process dies mid-turn its stdout simply ends and the
//! consumer stops — so a death can NEVER produce a false completion. Verified by
//! [`tests::sidecar_death_never_yields_false_completion`].
//!
//! ## Safety
//!
//! The Node sidecar (and the `claude` CLI grandchild the SDK spawns) inherit the server's
//! isolated HOME (so they authenticate from + write ALL transcript data under
//! `<isolatedHOME>/.claude`, never the user's real store) and carry a
//! `FRESHELL_CLAUDE_SIDECAR_ID` ownership tag. [`FreshClaudeState::shutdown`] SIGTERMs the
//! sidecar (which cleanly kills its own claude CLI via the SDK), SIGKILLs any straggler,
//! and runs the `/proc` ownership sweep; the harness sentinel sweep is the backstop — no
//! orphans.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

use freshell_protocol::{
    ErrorCode, ErrorMsg, FreshAgentCreate, FreshAgentCreateFailed, FreshAgentCreated,
    FreshAgentEvent, FreshAgentInterrupt, FreshAgentKill, FreshAgentKilled, FreshAgentSend,
    FreshAgentSendAccepted, ServerMessage, SessionType,
};

use crate::{FreshAgentCreateDedup, FreshAgentCreateOutcome};

/// The runtime provider (`AGENT_SESSION_TYPES.claude.provider`).
const PROVIDER: &str = "claude";
/// The ownership tag env the sidecar + its claude CLI grandchild carry (the codex analog
/// is `FRESHELL_CODEX_SIDECAR_ID`); the `/proc` reaper keys on it.
const CLAUDE_SIDECAR_OWNERSHIP_ENV: &str = "FRESHELL_CLAUDE_SIDECAR_ID";
/// Cold-boot budget for the sidecar to answer the `create` request (`created`).
const SIDECAR_CREATE_BUDGET: Duration = Duration::from_secs(45);

/// Shared, cheaply-cloneable freshclaude WS state (mergeable into the server app + WsState).
#[derive(Clone)]
pub struct FreshClaudeState {
    /// The shared WS broadcast bus (pre-serialized frames), fanned out by every
    /// `freshell-ws` connection so the oracle's capture socket records
    /// `freshAgent.created` / `freshAgent.send.accepted` / `freshAgent.event`.
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// placeholder-nanoid → live claude session (sidecar stdin + owned child + consumer).
    sessions: Arc<TokioMutex<HashMap<String, ClaudeSession>>>,
    /// `freshAgent.create` requestId dedup (parity gap fix -- see the module doc on
    /// [`crate::FreshAgentCreateDedup`]): single-flight + replay cache so a client
    /// resending the SAME `requestId` on every reconnect while a pane is
    /// `status==creating` reattaches to the ONE session it already created instead of
    /// spawning a fresh claude sidecar per resend. Cleared for a session's entries only
    /// on an explicit `freshAgent.kill` ([`Self::handle_kill`]); an unrequested sidecar
    /// exit does NOT evict (mirrors legacy, see the type doc).
    create_dedup: Arc<FreshAgentCreateDedup<ClaudeCreateRecord>>,
}

/// The cached result of a completed claude/kilroy `freshAgent.create`, keyed by
/// `requestId` in [`FreshClaudeState::create_dedup`]. Claude's `create()` returns only a
/// bare nanoid placeholder (no `sessionRef` -- `adapter.ts` returns `{ sessionId }` only),
/// so only `session_id` need be cached; the replay branch mirrors the live path's own
/// broadcast (NO `sessionRef`).
#[derive(Clone)]
struct ClaudeCreateRecord {
    session_id: String,
}

/// One live freshclaude session: the Node sidecar it drives + its stdout consumer.
struct ClaudeSession {
    /// stdin of the Node sidecar (write `create`/`send`/`shutdown` requests).
    stdin: ChildStdin,
    /// The owned Node sidecar child (SIGKILL backstop; `kill_on_drop`).
    child: Child,
    /// The `/proc` reaper tag for this session's sidecar + its claude CLI grandchild.
    ownership_id: String,
    /// The stdout-consumer task (aborted on shutdown).
    consumer: tokio::task::JoinHandle<()>,
}

impl FreshClaudeState {
    /// Build the state around the shared broadcast bus.
    pub fn new(broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>) -> Self {
        Self {
            broadcast_tx,
            sessions: Arc::new(TokioMutex::new(HashMap::new())),
            create_dedup: Arc::new(FreshAgentCreateDedup::new()),
        }
    }

    /// Reap every owned claude sidecar: SIGTERM the Node process (so it cleanly kills its
    /// own `claude` CLI via the SDK abort), SIGKILL any straggler, abort the consumer, and
    /// run the `/proc` ownership sweep for the grandchild. Called on server shutdown.
    pub async fn shutdown(&self) {
        let drained: Vec<ClaudeSession> = {
            let mut guard = self.sessions.lock().await;
            guard.drain().map(|(_, s)| s).collect()
        };
        for session in drained {
            session.consumer.abort();
            // Graceful: ask the sidecar to shut down (it aborts the SDK query, which kills
            // the claude CLI), then hard-stop the Node process, then sweep the grandchild.
            let mut stdin = session.stdin;
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n").await;
            let _ = stdin.flush().await;
            if let Some(pid) = session.child.id() {
                terminate_pid(pid as i32);
            }
            let mut child = session.child;
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&session.ownership_id);
        }
    }

    fn broadcast(&self, msg: &ServerMessage) {
        if let Ok(frame) = serde_json::to_string(msg) {
            let _ = self.broadcast_tx.send(frame);
        }
    }

    // ── freshAgent.create (WS) ───────────────────────────────────────────────────────

    /// Handle a `freshAgent.create` for claude/kilroy: spawn the Node sidecar, drive the
    /// SDK `create` to get the BARE nanoid placeholder, register the session + its stdout
    /// consumer, and broadcast `freshAgent.created` (or `freshAgent.create.failed`).
    /// Long-running (cold sidecar spawn), so the WS loop dispatches this as a detached task.
    pub async fn handle_create(&self, msg: FreshAgentCreate) {
        let request_id = msg.request_id.clone();
        let session_type = session_type_str(msg.session_type);

        // Dedup by requestId (parity gap fix -- see [`crate::FreshAgentCreateDedup`]'s
        // doc and [`Self::create_dedup`]'s field doc). Held for the whole creation
        // attempt below, so concurrent duplicate `create`s for the same requestId
        // serialize instead of each spawning their own sidecar.
        let _dedup_guard = match self.create_dedup.acquire_or_replay(&request_id).await {
            FreshAgentCreateOutcome::Replay(cached) => {
                self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
                    provider: PROVIDER.to_string(),
                    request_id,
                    runtime_provider: PROVIDER.to_string(),
                    session_id: cached.session_id,
                    session_type: session_type.to_string(),
                    session_ref: None,
                }));
                return;
            }
            FreshAgentCreateOutcome::Proceed(guard) => guard,
        };

        let (mut child, mut stdin, stdout, ownership_id) = match spawn_sidecar().await {
            Ok(parts) => parts,
            Err(err) => {
                self.fail_create(&request_id, "CLAUDE_SIDECAR_START_FAILED", &err);
                return;
            }
        };

        // Send the create request (faithful to createClaudeSdkOptions inputs).
        let create_req = json!({
            "type": "create",
            "requestId": request_id,
            "cwd": msg.cwd,
            "model": msg.model,
            "permissionMode": msg.permission_mode,
            "effort": msg.effort,
            "resumeSessionId": msg.resume_session_id,
        });
        if let Err(err) = write_line(&mut stdin, &create_req).await {
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&ownership_id);
            self.fail_create(&request_id, "CLAUDE_SIDECAR_WRITE_FAILED", &err);
            return;
        }

        // Read stdout until `created` / `create.failed` (bounded). Keep the reader to hand
        // to the consumer so no post-created event line is lost.
        let mut reader = BufReader::new(stdout).lines();
        let created = match read_created(&mut reader, SIDECAR_CREATE_BUDGET).await {
            Ok(session_id) => session_id,
            Err(err) => {
                let _ = child.start_kill();
                reap_owned_claude_sidecars(&ownership_id);
                self.fail_create(&request_id, "CLAUDE_CREATE_FAILED", &err);
                return;
            }
        };

        // Start the stdout consumer (the completion edge normalization lives here).
        let consumer = self.spawn_consumer(reader, created.clone(), session_type.to_string());

        self.sessions.lock().await.insert(
            created.clone(),
            ClaudeSession {
                stdin,
                child,
                ownership_id,
                consumer,
            },
        );

        // Cache the completed create for requestId dedup BEFORE responding (mirrors
        // codex/opencode: a duplicate `create` arriving right after this point must see
        // the cache populated, never race past this guard's release and spawn a second
        // sidecar).
        self.create_dedup
            .record_success(
                &request_id,
                ClaudeCreateRecord {
                    session_id: created.clone(),
                },
            )
            .await;

        // Broadcast freshAgent.created (ws-handler.ts:3378). NO sessionRef for claude
        // (adapter.ts returns { sessionId } only); placeholder == the bare nanoid.
        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id,
            runtime_provider: PROVIDER.to_string(),
            session_id: created,
            session_type: session_type.to_string(),
            session_ref: None,
        }));
    }

    fn fail_create(&self, request_id: &str, code: &str, message: &str) {
        self.broadcast(&ServerMessage::FreshAgentCreateFailed(
            FreshAgentCreateFailed {
                code: code.to_string(),
                message: message.to_string(),
                request_id: request_id.to_string(),
                retryable: None,
            },
        ));
    }

    // ── freshAgent.kill (WS) ─────────────────────────────────────────────────

    /// Handle a `freshAgent.kill` for claude/kilroy: remove the session and tear down
    /// its owned sidecar (graceful `shutdown` request, SIGTERM so the SDK cleanly kills
    /// its own `claude` CLI, `kill_on_drop` backstop, `/proc` ownership sweep), evict this
    /// session's requestId dedup cache entries (mirrors
    /// `clearFreshAgentCreateCachesForSession`, `ws-handler.ts:1044-1050`, called from
    /// `ws-handler.ts:3673`), then broadcast `freshAgent.killed`. Idempotent for an
    /// unknown session id, matching the codex/opencode `success:true` pattern.
    pub async fn handle_kill(&self, msg: FreshAgentKill) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        let removed = self.sessions.lock().await.remove(&session_id);
        if let Some(session) = removed {
            session.consumer.abort();
            let mut stdin = session.stdin;
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n").await;
            let _ = stdin.flush().await;
            if let Some(pid) = session.child.id() {
                terminate_pid(pid as i32);
            }
            let mut child = session.child;
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&session.ownership_id);
        }

        // Explicit kill evicts this session's requestId dedup cache entries (mirrors
        // `clearFreshAgentCreateCachesForSession`) -- a later duplicate `create` for the
        // same requestId must genuinely mint a fresh session, not replay the one just
        // killed.
        self.create_dedup
            .clear_for_session(|record| record.session_id == session_id)
            .await;

        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
            provider: PROVIDER.to_string(),
            session_id,
            session_type: session_type.to_string(),
            success: true,
        }));
    }

    // ── freshAgent.interrupt (WS) ────────────────────────────────────────────

    /// Handle a `freshAgent.interrupt` for claude/kilroy: forward an `interrupt`
    /// request to the owned sidecar, which calls the SDK's `query.interrupt()` --
    /// mirrors `server/fresh-agent/adapters/claude/adapter.ts:163-168`'s
    /// `interrupt(sessionId) { mapMissingResult(deps.sdkBridge.interrupt(sessionId), ...) }`
    /// -> `server/sdk-bridge.ts:785-793`'s `sp.query.interrupt().catch(warn)`. Fire-and-
    /// forget on success: legacy's `ws-handler.ts:3503-3517` sends NO confirmation frame
    /// when `manager.interrupt(locator)` resolves, only `sendError` on a throw -- so a
    /// successful interrupt here broadcasts nothing either. A missing session mirrors
    /// the `SESSION_NOT_FOUND` convention [`Self::handle_send`] already established for
    /// this provider (and codex/opencode's own `handle_interrupt`), rather than
    /// reproducing legacy's adapter-specific message text verbatim.
    pub async fn handle_interrupt(&self, msg: FreshAgentInterrupt) {
        let session_id = msg.session_id.clone();

        let interrupt_req = json!({ "type": "interrupt", "sessionId": session_id });
        let mut guard = self.sessions.lock().await;
        let Some(session) = guard.get_mut(&session_id) else {
            drop(guard);
            self.send_error(&None, "SESSION_NOT_FOUND", "claude session not found");
            return;
        };
        if let Err(err) = write_line(&mut session.stdin, &interrupt_req).await {
            drop(guard);
            self.send_error(&None, "CLAUDE_INTERRUPT_FAILED", &err);
        }
        // Success: no broadcast (mirrors legacy's silent fire-and-forget interrupt).
    }

    // ── freshAgent.send (WS) ─────────────────────────────────────────────────────────

    /// Handle a `freshAgent.send` for claude: push the user turn into the sidecar's SDK
    /// input stream, then broadcast `freshAgent.send.accepted`. The stdout consumer surfaces
    /// the completion edge (`sdk.result subtype=success` → `freshAgent.turn.complete`).
    /// Claude's send returns void, so NO `submittedTurnId` and NO materialization.
    pub async fn handle_send(&self, msg: FreshAgentSend) {
        let request_id = msg.request_id.clone();
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        let send_req = json!({ "type": "send", "sessionId": session_id, "text": msg.text });
        let mut guard = self.sessions.lock().await;
        let Some(session) = guard.get_mut(&session_id) else {
            drop(guard);
            self.send_error(&request_id, "SESSION_NOT_FOUND", "claude session not found");
            return;
        };
        if let Err(err) = write_line(&mut session.stdin, &send_req).await {
            drop(guard);
            self.send_error(&request_id, "CLAUDE_SEND_FAILED", &err);
            return;
        }
        drop(guard);

        self.broadcast(&ServerMessage::FreshAgentSendAccepted(
            FreshAgentSendAccepted {
                provider: PROVIDER.to_string(),
                request_id: request_id.unwrap_or_default(),
                session_id,
                session_type: session_type.to_string(),
                cwd: msg.cwd,
                submitted_turn_id: None,
            },
        ));
    }

    fn send_error(&self, request_id: &Option<String>, code: &str, message: &str) {
        self.broadcast(&ServerMessage::Error(ErrorMsg {
            code: ErrorCode::InternalError,
            message: format!("{code}: {message}"),
            timestamp: now_iso(),
            actual_session_ref: None,
            expected_session_ref: None,
            request_id: request_id.clone(),
            terminal_exit_code: None,
            terminal_id: None,
        }));
    }

    // ── stdout consumer (the completion edge normalization) ──────────────────────────

    /// Consume the sidecar's stdout event stream (one `sdk.*` JSON per line), normalize
    /// each `sdk.* → freshAgent.*` and broadcast it wrapped in a `freshAgent.event`. On EOF
    /// (a clean end OR a mid-turn death) the loop just stops — never a false completion.
    fn spawn_consumer(
        &self,
        mut reader: tokio::io::Lines<BufReader<ChildStdout>>,
        session_id: String,
        session_type: String,
    ) -> tokio::task::JoinHandle<()> {
        let broadcast_tx = self.broadcast_tx.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                if let Some(frame) = sdk_line_to_frame(&value, &session_id, &session_type) {
                    let _ = broadcast_tx.send(frame);
                }
            }
        })
    }
}

// ── sdk.* → freshAgent.event frame (port of sdk-events.ts normalizeFreshAgentProviderEvent) ─

/// Map an `sdk.*` event line from the sidecar to a `freshAgent.event` wire frame. Renames
/// the inner `type` `sdk.X → freshAgent.X` (only the known set — matching sdk-events.ts,
/// which passes unknown types through unchanged and thus never surfaces them as fresh-agent
/// events), preserving every other field, then wraps it in the envelope. Control lines
/// (`created` / `create.failed`) and unknown types return `None`.
fn sdk_line_to_frame(value: &Value, session_id: &str, session_type: &str) -> Option<String> {
    let sdk_type = value.get("type").and_then(Value::as_str)?;
    let fresh_type = normalize_sdk_type(sdk_type)?;

    // Clone the inner event, swapping only its `type` (structural parity with the TS
    // `{ ...providerEvent, type }` spread).
    let mut inner: Map<String, Value> = value.as_object()?.clone();
    inner.insert("type".to_string(), json!(fresh_type));

    let msg = ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: Value::Object(inner),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type.to_string(),
    });
    serde_json::to_string(&msg).ok()
}

/// The `sdk.* → freshAgent.*` rename table (server/fresh-agent/sdk-events.ts:48-83). Returns
/// `None` for a non-`sdk.` or unrecognized type (which the reference leaves unmapped).
fn normalize_sdk_type(sdk_type: &str) -> Option<&'static str> {
    Some(match sdk_type {
        "sdk.session.snapshot" => "freshAgent.session.snapshot",
        "sdk.session.changed" => "freshAgent.session.changed",
        "sdk.session.init" => "freshAgent.session.init",
        "sdk.session.metadata" => "freshAgent.session.metadata",
        "sdk.assistant" => "freshAgent.assistant",
        "sdk.stream" => "freshAgent.stream",
        "sdk.result" => "freshAgent.result",
        "sdk.permission.request" => "freshAgent.permission.request",
        "sdk.permission.cancelled" => "freshAgent.permission.cancelled",
        "sdk.question.request" => "freshAgent.question.request",
        "sdk.status" => "freshAgent.status",
        "sdk.turn.complete" => "freshAgent.turn.complete",
        "sdk.turn.waiting" => "freshAgent.turn.waiting",
        "sdk.error" => "freshAgent.error",
        "sdk.exit" => "freshAgent.exit",
        "sdk.killed" => "freshAgent.killed",
        _ => return None,
    })
}

/// `SessionType → wire string` for the claude provider (`freshclaude` | `kilroy`; both map
/// to provider `claude`). Any non-claude session type defaults to `freshclaude` (this slice
/// is only ever dispatched for the claude provider).
fn session_type_str(session_type: SessionType) -> &'static str {
    match session_type {
        SessionType::Kilroy => "kilroy",
        _ => "freshclaude",
    }
}

// ── Node sidecar spawn ──────────────────────────────────────────────────────────────────

/// Spawn `node <sidecar>/index.mjs`, ownership-tagged, inheriting the server's isolated HOME
/// (so the SDK's `claude` CLI authenticates from + writes under `<isolatedHOME>/.claude`).
/// Returns the owned child, its stdin, its stdout, and the ownership tag.
async fn spawn_sidecar() -> Result<(Child, ChildStdin, ChildStdout, String), String> {
    let entry = sidecar_entry_path();
    if !entry.exists() {
        return Err(format!(
            "claude sidecar entry not found at {}",
            entry.display()
        ));
    }
    let node = std::env::var("FRESHELL_CLAUDE_NODE").unwrap_or_else(|_| "node".to_string());
    let ownership_id = mint_ownership_id();

    let mut cmd = tokio::process::Command::new(&node);
    cmd.arg(&entry);
    // Inherit the parent env (HOME=<isolated>, CLAUDE_HOME=<isolated>/.claude) and layer the
    // ownership tag so the /proc reaper can find our sidecar AND the claude CLI grandchild
    // (the SDK's clean-env passes FRESHELL_CLAUDE_SIDECAR_ID through — it strips only
    // CLAUDECODE + ANTHROPIC_API_KEY).
    cmd.env(CLAUDE_SIDECAR_OWNERSHIP_ENV, &ownership_id);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "claude sidecar spawn failed ({node} {}): {e}",
            entry.display()
        )
    })?;
    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    // Drain stderr so verbose SDK/CLI logs can never fill the pipe and stall the sidecar.
    if let Some(err) = child.stderr.take() {
        drain_reader(err);
    }
    Ok((child, stdin, stdout, ownership_id))
}

/// Read the sidecar's stdout until the `created` (→ the nanoid placeholder) or
/// `create.failed` control line, bounded by `budget`. EOF before either is a failure.
async fn read_created(
    reader: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    budget: Duration,
) -> Result<String, String> {
    let read = async {
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    match value.get("type").and_then(Value::as_str) {
                        Some("created") => {
                            let session_id = value
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .ok_or("created carried no sessionId")?;
                            return Ok(session_id.to_string());
                        }
                        Some("create.failed") => {
                            let message = value
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown sidecar create failure");
                            return Err(message.to_string());
                        }
                        // sdk.* events before `created` are impossible (the sidecar emits
                        // `created` first), but tolerate + skip any stray line.
                        _ => continue,
                    }
                }
                // EOF before `created` → the sidecar died at startup (e.g. bad node/SDK).
                Ok(None) => return Err("sidecar stdout closed before `created`".to_string()),
                Err(e) => return Err(format!("sidecar stdout read error: {e}")),
            }
        }
    };
    match tokio::time::timeout(budget, read).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "sidecar did not answer `create` within {}s",
            budget.as_secs()
        )),
    }
}

/// Resolve the sidecar entry (`index.mjs`). `FRESHELL_CLAUDE_SIDECAR` overrides; otherwise
/// the vendored package sits beside this crate at `crates/freshell-claude-sidecar/index.mjs`
/// (baked from `CARGO_MANIFEST_DIR` so it is cwd-independent).
fn sidecar_entry_path() -> PathBuf {
    if let Ok(path) = std::env::var("FRESHELL_CLAUDE_SIDECAR") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../freshell-claude-sidecar/index.mjs"
    ))
}

/// Write one newline-delimited JSON request to the sidecar's stdin.
async fn write_line(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

/// Drain an async child pipe to `/dev/null` so it never back-pressures the sidecar.
fn drain_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(mut reader: R) {
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });
}

// ── ownership / reaping (Linux /proc, mirrors freshell-codex) ───────────────────────────

/// Mint a unique sidecar ownership id (`claude-sidecar-<uuid>`) — the codex analog is
/// `codex-sidecar-<uuid>` (`runtime.ts:924`).
fn mint_ownership_id() -> String {
    format!("claude-sidecar-{}", uuid::Uuid::new_v4())
}

/// SIGTERM one pid (best-effort; the target is our own sidecar).
#[cfg(target_os = "linux")]
fn terminate_pid(pid: i32) {
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}
#[cfg(not(target_os = "linux"))]
fn terminate_pid(_pid: i32) {}

/// `killOwnedProcesses` analog for claude: SIGTERM any process whose `/proc/<pid>/environ`
/// carries our `FRESHELL_CLAUDE_SIDECAR_ID=<ownership_id>` tag — the Node sidecar AND the
/// `claude` CLI grandchild the SDK spawns (which inherits the tag through the SDK clean-env).
/// Linux `/proc`-based, best-effort; only processes carrying OUR unique tag are signaled.
#[cfg(target_os = "linux")]
fn reap_owned_claude_sidecars(ownership_id: &str) {
    let needle = format!("{CLAUDE_SIDECAR_OWNERSHIP_ENV}={ownership_id}");
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        let carries_tag = environ
            .split(|&b| b == 0)
            .any(|var| var == needle.as_bytes());
        if carries_tag {
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
}
#[cfg(not(target_os = "linux"))]
fn reap_owned_claude_sidecars(_ownership_id: &str) {
    // Non-Linux: the direct child is reaped via kill_on_drop; the /proc environ scan is
    // Linux-only (matches the reference's platform guard).
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────

/// ISO-8601 / RFC-3339 millis-Z timestamp (`new Date().toISOString()`) for error frames.
fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> FreshClaudeState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshClaudeState::new(Arc::new(tx))
    }

    #[test]
    fn normalize_maps_the_known_sdk_set_and_ignores_others() {
        assert_eq!(
            normalize_sdk_type("sdk.session.init"),
            Some("freshAgent.session.init")
        );
        assert_eq!(
            normalize_sdk_type("sdk.assistant"),
            Some("freshAgent.assistant")
        );
        assert_eq!(normalize_sdk_type("sdk.stream"), Some("freshAgent.stream"));
        assert_eq!(normalize_sdk_type("sdk.result"), Some("freshAgent.result"));
        assert_eq!(
            normalize_sdk_type("sdk.turn.complete"),
            Some("freshAgent.turn.complete")
        );
        assert_eq!(
            normalize_sdk_type("sdk.turn.waiting"),
            Some("freshAgent.turn.waiting")
        );
        // Control + unknown types are NOT surfaced as fresh-agent events.
        assert_eq!(normalize_sdk_type("created"), None);
        assert_eq!(normalize_sdk_type("create.failed"), None);
        assert_eq!(normalize_sdk_type("sdk.unknown"), None);
    }

    #[test]
    fn session_init_frame_carries_inner_type_and_durable_uuid() {
        // sdk.session.init → freshAgent.event { event.type: freshAgent.session.init, cliSessionId }.
        let line = json!({
            "type": "sdk.session.init",
            "sessionId": "nano_placeholder_1234567",
            "cliSessionId": "0199abcd-1234-7abc-8def-0123456789ab",
            "model": "haiku",
            "cwd": "/tmp/x",
            "tools": [{ "name": "Read" }],
        });
        let frame = sdk_line_to_frame(&line, "nano_placeholder_1234567", "freshclaude").unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["type"], "freshAgent.event");
        assert_eq!(wire["provider"], "claude");
        assert_eq!(wire["sessionType"], "freshclaude");
        assert_eq!(wire["sessionId"], "nano_placeholder_1234567");
        assert_eq!(wire["event"]["type"], "freshAgent.session.init");
        assert_eq!(
            wire["event"]["cliSessionId"],
            "0199abcd-1234-7abc-8def-0123456789ab"
        );
        assert_eq!(wire["event"]["model"], "haiku");
    }

    #[test]
    fn turn_complete_frame_carries_the_success_edge() {
        // The status-guarded chime the sidecar emits ONLY on result subtype=success.
        let line = json!({ "type": "sdk.turn.complete", "sessionId": "s-1", "at": 42 });
        let frame = sdk_line_to_frame(&line, "s-1", "freshclaude").unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["type"], "freshAgent.event");
        assert_eq!(wire["event"]["type"], "freshAgent.turn.complete");
        assert_eq!(wire["event"]["at"], 42);
    }

    #[test]
    fn control_lines_are_not_forwarded_as_events() {
        // `created` / `create.failed` are handled in the create flow, never as events.
        assert!(sdk_line_to_frame(
            &json!({ "type": "created", "sessionId": "x" }),
            "x",
            "freshclaude"
        )
        .is_none());
        assert!(sdk_line_to_frame(
            &json!({ "type": "create.failed", "message": "boom" }),
            "x",
            "freshclaude"
        )
        .is_none());
    }

    #[test]
    fn sidecar_death_never_yields_false_completion() {
        // The ADR Decision 2.1 property: a mid-turn death (stdout ends after some events but
        // BEFORE any sdk.turn.complete) can NEVER produce a freshAgent.turn.complete. We
        // model the consumer's mapping over a death-truncated line stream and assert no
        // completion frame is produced.
        let death_stream = [
            json!({ "type": "sdk.session.init", "sessionId": "s", "cliSessionId": "0199abcd-1234-7abc-8def-0123456789ab" }),
            json!({ "type": "sdk.stream", "sessionId": "s", "event": { "type": "content_block_delta" } }),
            json!({ "type": "sdk.assistant", "sessionId": "s", "content": [{ "type": "text", "text": "part" }] }),
            // …process is SIGKILLed here — stdout ends. NO sdk.result, NO sdk.turn.complete.
        ];
        let frames: Vec<Value> = death_stream
            .iter()
            .filter_map(|l| sdk_line_to_frame(l, "s", "freshclaude"))
            .map(|f| serde_json::from_str(&f).unwrap())
            .collect();
        let inner_types: Vec<&str> = frames
            .iter()
            .map(|f| f["event"]["type"].as_str().unwrap())
            .collect();
        assert!(
            !inner_types.contains(&"freshAgent.turn.complete"),
            "a death-truncated stream must never yield a completion chime, got {inner_types:?}"
        );
        // And a subsequent success stream DOES complete — the edge is real, not disabled.
        let ok = sdk_line_to_frame(
            &json!({ "type": "sdk.turn.complete", "sessionId": "s", "at": 1 }),
            "s",
            "freshclaude",
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&ok).unwrap()["event"]["type"],
            "freshAgent.turn.complete"
        );
    }

    #[test]
    fn session_type_maps_claude_flavours() {
        assert_eq!(session_type_str(SessionType::Freshclaude), "freshclaude");
        assert_eq!(session_type_str(SessionType::Kilroy), "kilroy");
    }

    #[test]
    fn ownership_id_is_unique_and_tagged() {
        let a = mint_ownership_id();
        let b = mint_ownership_id();
        assert!(a.starts_with("claude-sidecar-"));
        assert_ne!(a, b);
    }

    #[test]
    fn sidecar_entry_resolves_to_the_vendored_package() {
        // Guard against the dedup tests' concurrent FRESHELL_CLAUDE_SIDECAR mutation
        // (see CLAUDE_ENV_LOCK below) -- this test reads the SAME process-global env var.
        let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        // The compile-time path points at the vendored Node package beside this crate.
        let entry = sidecar_entry_path();
        assert!(
            entry.ends_with("freshell-claude-sidecar/index.mjs"),
            "{}",
            entry.display()
        );
    }

    #[tokio::test]
    async fn shutdown_is_safe_with_no_sessions() {
        state().shutdown().await;
    }

    // ── freshAgent.create requestId dedup (parity gap fix) ──────────────────

    /// Serializes every test in this file that mutates process-global env vars
    /// (`FRESHELL_CLAUDE_SIDECAR` / `FRESHELL_CLAUDE_NODE`), mirroring codex's
    /// `ENV_LOCK` (`codex.rs`).
    static CLAUDE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A minimal scripted fake claude sidecar (no real `@anthropic-ai/claude-agent-sdk`,
    /// no network, no cost): on `{"type":"create",...}` it appends a marker line to
    /// `FRESHELL_TEST_CLAUDE_SPAWN_LOG` (so tests can count spawns without a global
    /// tracing subscriber) and replies with a fresh `{"type":"created","sessionId":...}`;
    /// on `{"type":"interrupt",sessionId}` it appends `sessionId` to
    /// `FRESHELL_TEST_CLAUDE_INTERRUPT_LOG` (the observable proxy for "the sidecar's
    /// `query.interrupt()` was actually invoked", mirroring the real sidecar's
    /// `handleInterrupt`); on `{"type":"shutdown"}` it exits. `send` is intentionally
    /// unhandled -- the dedup tests never exercise it.
    const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import fs from 'node:fs'
import readline from 'node:readline'

const spawnLog = process.env.FRESHELL_TEST_CLAUDE_SPAWN_LOG
if (spawnLog) {
  fs.appendFileSync(spawnLog, `${process.pid}\n`)
}

let counter = 0
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (msg.type === 'create') {
    counter += 1
    const sessionId = `fake-claude-session-${process.pid}-${counter}`
    process.stdout.write(JSON.stringify({ type: 'created', sessionId }) + '\n')
  } else if (msg.type === 'interrupt') {
    const interruptLog = process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_LOG
    if (interruptLog) fs.appendFileSync(interruptLog, `${msg.sessionId}\n`)
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

    /// A fresh temp dir holding the fake sidecar script + this test's spawn-count log,
    /// with `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE`/
    /// `FRESHELL_TEST_CLAUDE_SPAWN_LOG` pointed at it. Caller must hold
    /// [`CLAUDE_ENV_LOCK`] for the lifetime of the returned guard.
    struct FakeClaudeSidecarEnv {
        dir: PathBuf,
        spawn_log: PathBuf,
        interrupt_log: PathBuf,
    }
    impl FakeClaudeSidecarEnv {
        fn install() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "freshell-fake-claude-sidecar-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
            let script = dir.join("fake-claude-sidecar.mjs");
            std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
            let spawn_log = dir.join("spawn.log");
            std::fs::write(&spawn_log, "").expect("init spawn log");
            let interrupt_log = dir.join("interrupt.log");
            std::fs::write(&interrupt_log, "").expect("init interrupt log");
            std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
            std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
            std::env::set_var("FRESHELL_TEST_CLAUDE_SPAWN_LOG", &spawn_log);
            std::env::set_var("FRESHELL_TEST_CLAUDE_INTERRUPT_LOG", &interrupt_log);
            Self {
                dir,
                spawn_log,
                interrupt_log,
            }
        }

        /// Number of times the fake sidecar has been spawned so far (one marker line per
        /// process start).
        fn spawn_count(&self) -> usize {
            std::fs::read_to_string(&self.spawn_log)
                .map(|s| s.lines().filter(|l| !l.is_empty()).count())
                .unwrap_or(0)
        }

        /// Contents of the interrupt log (one `sessionId` per line the fake sidecar
        /// received a `{"type":"interrupt",...}` request for).
        fn interrupt_log_contents(&self) -> String {
            std::fs::read_to_string(&self.interrupt_log).unwrap_or_default()
        }
    }
    impl Drop for FakeClaudeSidecarEnv {
        fn drop(&mut self) {
            std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
            std::env::remove_var("FRESHELL_CLAUDE_NODE");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_SPAWN_LOG");
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn dedup_create_msg(request_id: &str) -> FreshAgentCreate {
        FreshAgentCreate {
            request_id: request_id.to_string(),
            session_type: SessionType::Freshclaude,
            provider: Some(freshell_protocol::AgentProvider::Claude),
            cwd: None,
            legacy_restore_context: None,
            resume_session_id: None,
            session_ref: None,
            model: None,
            model_selection: None,
            permission_mode: None,
            sandbox: None,
            effort: None,
            plugins: None,
        }
    }

    /// Drain `rx` until the `freshAgent.created` (or `.create.failed`) frame for
    /// `request_id` arrives (mirrors codex's `await_created`).
    async fn await_claude_created(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        request_id: &str,
    ) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if (frame["type"] == "freshAgent.created"
                    || frame["type"] == "freshAgent.create.failed")
                    && frame["requestId"] == request_id
                {
                    return frame;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("freshAgent.created for {request_id} resolves within budget"))
    }

    /// THE regression this task fixes: a duplicate `freshAgent.create` sharing a
    /// `requestId` (the frozen client's reconnect-resend while a pane is
    /// `status==creating`) must spawn the claude sidecar exactly once and replay the
    /// SAME session id on the second response.
    #[tokio::test]
    async fn handle_create_duplicate_request_id_reuses_the_session_and_spawns_once() {
        let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-seq"))
            .await;
        let first = await_claude_created(&mut rx, "req-claude-dedup-seq").await;
        assert_eq!(first["type"], "freshAgent.created", "sanity: {first}");
        let first_session_id = first["sessionId"].as_str().unwrap().to_string();

        st.handle_create(dedup_create_msg("req-claude-dedup-seq"))
            .await;
        let second = await_claude_created(&mut rx, "req-claude-dedup-seq").await;

        assert_eq!(
            second["sessionId"], first_session_id,
            "a duplicate requestId must replay the SAME session, not mint a new one: {second}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "two sequential creates sharing a requestId must spawn the claude sidecar \
             exactly once"
        );
    }

    /// The concurrent variant: two GENUINELY CONCURRENT creates sharing a `requestId`
    /// must still spawn at most one sidecar and both resolve to the SAME session.
    #[tokio::test]
    async fn handle_create_concurrent_duplicate_request_id_spawns_at_most_once() {
        let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        let st1 = st.clone();
        let st2 = st.clone();
        tokio::join!(
            st1.handle_create(dedup_create_msg("req-claude-dedup-race")),
            st2.handle_create(dedup_create_msg("req-claude-dedup-race")),
        );

        let first = await_claude_created(&mut rx, "req-claude-dedup-race").await;
        let second = await_claude_created(&mut rx, "req-claude-dedup-race").await;
        assert_eq!(
            first["sessionId"], second["sessionId"],
            "both racing creates for the same requestId must resolve to the SAME session: \
             {first} / {second}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "two CONCURRENT creates racing on the same requestId must spawn the claude \
             sidecar exactly once"
        );
    }

    /// Control: DISTINCT requestIds must never dedup against each other.
    #[tokio::test]
    async fn handle_create_distinct_request_ids_create_distinct_sessions() {
        let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-a"))
            .await;
        let a = await_claude_created(&mut rx, "req-claude-dedup-a").await;

        st.handle_create(dedup_create_msg("req-claude-dedup-b"))
            .await;
        let b = await_claude_created(&mut rx, "req-claude-dedup-b").await;

        assert_ne!(
            a["sessionId"], b["sessionId"],
            "distinct requestIds must never replay each other's session: {a} / {b}"
        );
        assert_eq!(
            env.spawn_count(),
            2,
            "two distinct requestIds must spawn the sidecar once each"
        );
    }

    /// Cache invalidation: an EXPLICIT `freshAgent.kill` DOES evict the requestId dedup
    /// cache, so a duplicate `create` for the SAME requestId after the kill genuinely
    /// mints a fresh session (a new spawn), not a replay of the killed one.
    ///
    /// NOTE (task-specified suite reduction, justified): unlike codex, claude has no
    /// exit-watcher/self-heal state machine ([`ClaudeSession`] carries no `exited` bit --
    /// an unrequested sidecar death is simply an EOF the stdout consumer stops on, with
    /// no separate "replay after unrequested exit" code path for the dedup cache to
    /// interact with). That codex-suite test would be a byte-for-byte duplicate of
    /// `handle_create_duplicate_request_id_reuses_the_session_and_spawns_once` here, so
    /// it is dropped rather than mirrored redundantly -- 4 tests, not 5.
    #[tokio::test]
    async fn handle_create_duplicate_after_explicit_kill_creates_a_fresh_session() {
        let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-kill"))
            .await;
        let created = await_claude_created(&mut rx, "req-claude-dedup-kill").await;
        let killed_session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: killed_session_id.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        st.handle_create(dedup_create_msg("req-claude-dedup-kill"))
            .await;
        let recreated = await_claude_created(&mut rx, "req-claude-dedup-kill").await;

        assert_ne!(
            recreated["sessionId"], killed_session_id,
            "a duplicate create after an EXPLICIT kill must mint a fresh session, not \
             replay the killed one: {recreated}"
        );
        assert_eq!(
            env.spawn_count(),
            2,
            "the kill must evict the dedup cache, so the duplicate create genuinely \
             re-spawns"
        );
    }

    /// `freshAgent.kill` for an session id this process never created is idempotent
    /// (`success:true`), matching the codex/opencode pattern.
    #[tokio::test]
    async fn handle_kill_of_unknown_session_still_broadcasts_success() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "unknown-session".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.killed");
        assert_eq!(frame["success"], true);
        assert_eq!(frame["sessionId"], "unknown-session");
    }

    // ── freshAgent.interrupt (parity gap fix -- see terminal.rs's dispatch arm) ────

    /// A missing session mirrors the `SESSION_NOT_FOUND` convention already
    /// established by [`FreshClaudeState::handle_send`] (and codex/opencode's own
    /// `handle_interrupt`): an `error` frame, never a silent drop.
    #[tokio::test]
    async fn handle_interrupt_errors_for_unknown_session() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_interrupt(FreshAgentInterrupt {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "does-not-exist".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "error");
        assert!(
            frame["message"]
                .as_str()
                .unwrap()
                .contains("claude session not found"),
            "{frame}"
        );
    }

    /// A known session's interrupt is forwarded to the sidecar (the Rust-side half of
    /// the parity fix -- mirrors `adapters/claude/adapter.ts:163-168`'s
    /// `sdkBridge.interrupt(sessionId)` -> `sp.query.interrupt()`), observed via the
    /// fake sidecar's interrupt log since a successful interrupt broadcasts NOTHING
    /// (fire-and-forget, matching legacy exactly -- there is no confirmation frame to
    /// assert on instead).
    #[tokio::test]
    async fn handle_interrupt_forwards_the_request_to_the_sidecar_for_a_known_session() {
        let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-interrupt"))
            .await;
        let created = await_claude_created(&mut rx, "req-claude-interrupt").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_interrupt(FreshAgentInterrupt {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        // Bounded poll for the fake sidecar's interrupt log (it's an OS-level pipe
        // write, not synchronous with `handle_interrupt`'s `write_line` await).
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if env.interrupt_log_contents().contains(&session_id) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!(
                    "sidecar never logged the interrupt for {session_id}: {:?}",
                    env.interrupt_log_contents()
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Success is silent -- no `error`/other frame was broadcast for this interrupt.
        assert!(rx.try_recv().is_err(), "a successful interrupt must not broadcast");
    }
}
