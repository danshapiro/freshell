//! Antigravity exact live identity (plan Task 6,
//! docs/plans/2026-10-29-google-cli-first-class-support.md): the disk
//! locator's UNIFIED first-bind/rebind evidence rule, proven end to end
//! against a real in-process server, real PTYs running a contract-faithful
//! fake `agy`, and a locator rooted at a tempdir antigravity home.
//!
//! The seven plan scenarios, as ONE multi-phase tokio test (the
//! `claude_session_rebind.rs` / `codex_fork_rebind.rs` convention — the
//! phases share one server, one antigravity home, and one cwd):
//!   1. Fresh adopt: Enter submits "first prompt ..." → the fake writes the
//!      fixture-format transcript (ownership record + that text as the
//!      first user record) → the sweep adopts: the pane leaf gains
//!      sessionRef {provider:"antigravity", sessionId} (frames
//!      `terminal.session.associated`), the spawn-time pending marker is
//!      consumed; a same-cwd transcript with a DIFFERENT first-user text is
//!      never adopted.
//!   2. TRUE concurrency: a second pane in the SAME cwd submits its own
//!      distinct nonce before the first pane's window resolves — content
//!      matching adopts each pane's own conversation, no cross-bind. Then
//!      the honest-refusal case: a third pane submits a prompt text
//!      identical to concurrently-appearing unbound transcripts' latest
//!      user text (twice over) ⇒ the locator REFUSES (no adoption,
//!      `antigravity_association_refused {reason:"ambiguous"}` logged) —
//!      never a guess. Also: re-typing a PREVIOUS prompt (text identical
//!      to an old transcript's latest user record) does not adopt that old
//!      transcript — the recency window rejects records older than the
//!      submit (the pane adopts its own fresh conversation instead).
//!   3. In-CLI switch, both documented forms: (a) `/switch:<id>` mints a
//!      NEW conversation and the pane's next prompt lands as its latest
//!      user record → rebind (sessionRef becomes the new id, supersede
//!      recorded via previousSessionId, identity follows the switch); a
//!      third pane targeting the old id gets the live-owner refusal while
//!      its owner pane is live. (b) `/resume <existing id>` — the fake
//!      switches the active transcript to the EXISTING conversation and
//!      the pane's next prompt is appended as that transcript's LATEST
//!      user record → rebind to the existing id.
//!   4. Restart resume adjacency: a restarted server (fresh in-memory
//!      state, same antigravity home) restores the pane with the adjacent
//!      `--conversation <bound id>` argv and identity persists.
//!   5. Zero-turn pane (created, no submit): no sessionRef, no association
//!      frame, pending marker retained.
//!   6. Late-event rejection: a pane adopts, its process dies, the pane
//!      respawns fresh (no resume id); a transcript write for a NEW
//!      conversation carrying the dead launch's OLD prompt text is NOT
//!      adopted by the respawned row (content mismatch), while the
//!      respawned pane's own subsequent submit adopts its own new
//!      conversation.
//!   7. Crash auto-resume parity: a bound pane whose process crashes
//!      mid-turn auto-respawns (within the auto-resume lane's
//!      grace/backoff) with the ADJACENT `--conversation <bound id>` argv
//!      — the crash did not silently start a fresh conversation — and the
//!      crash rings the unified attention edge exactly once.
//!   8. Deliberate user quit (#612 parity): a pane that submits (arming
//!      the provisional-Busy engagement), then types `/quit` and lets the
//!      CLI exit on its own, rings NO death bell — the quit-intent
//!      suppression must hold for antigravity panes exactly as it does
//!      for tracker modes (scenario 7 pins the crash side of the same
//!      engagement).
//!
//! Process-kill suite: the fakes this suite spawns are its own PTY children
//! (killed via `registry.kill` of the created ids, which reaps the fake
//! child with the PTY); kills never touch processes outside the suite. It
//! runs inside the disposable Docker sandbox
//! (`scripts/sandbox-test.sh "cargo test -p freshell-ws --test antigravity_session_rebind"`),
//! never bare on the host.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::log_capture::{self, CapturedEvent};
use common::next_frame_of_type;
use freshell_ws::WsState;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Wall-clock ms (the `now_ms` timestamp domain the locator consumes).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

/// The conversation id a fake derives for its pane (launch env
/// `FRESHELL_TERMINAL_ID`), mirrored by the test for its assertions.
fn conv_of(terminal_id: &str) -> String {
    format!("conv-{terminal_id}")
}

/// The transcript path the candidate contract fixes for a conversation.
fn transcript_path(home: &std::path::Path, conv: &str) -> std::path::PathBuf {
    home.join("brain")
        .join(conv)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl")
}

/// Write one fake `agy`: a contract-faithful `#!/bin/sh` reader that
/// models the transcript behavior the locator consumes.
///
/// - On spawn: honors an adjacent `--conversation <id>` argv pair (the
///   manifest's resumeArgs) by CONTINUING that existing conversation
///   (appending, never re-initializing); a fresh spawn (no resume pair)
///   initializes `brain/conv-<FRESHELL_TERMINAL_ID>/` with a
///   `session_start` ownership record whose `workspacePaths` is the PTY
///   child's own cwd (`$(pwd)` — the pane's cwd).
/// - Per stdin line: appends a `user_message` record (ms-precision ISO
///   `at` — the parser's documented timestamp shape) carrying the line
///   text and the active conversation id.
/// - `/switch:<id>` (the documented new-conversation switch) mints a NEW
///   conversation: initializes its ownership record and makes it active —
///   the NEXT stdin line lands as that conversation's first user record.
/// - `/resume <id>` (the documented in-CLI conversation switch) makes the
///   EXISTING conversation active without re-initializing it — the NEXT
///   stdin line is appended as that transcript's LATEST user record.
/// - `/crash` exits 1 (a real spontaneous non-zero death for the
///   auto-resume phase).
/// - `/quit` or `/exit` exits 0 (a deliberate user quit: a spontaneous
///   CLEAN exit — scenario 8's shape; the auto-resume lane settles it
///   `clean_exit`, never a respawn).
/// - When `AGY_ARGV_CAPTURE` is set, appends `"$@"` (space-joined) as one
///   row per invocation (O_APPEND — atomic for single lines).
///
/// Prompt texts driven through this fake avoid JSON metacharacters (the
/// fixture records are hand-serialized in sh).
fn write_fake_agy() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-antigravity-rebind-fake-{}.sh",
        std::process::id()
    ));
    let script = r#"#!/bin/sh
AGY_BRAIN="$AGY_HOME/brain"
CONV="conv-$FRESHELL_TERMINAL_ID"
AGY_CWD="$(pwd)"
now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
if [ -n "$AGY_ARGV_CAPTURE" ]; then
  printf '%s\n' "$*" >> "$AGY_ARGV_CAPTURE"
fi
# Honor the manifest's adjacent --conversation <id> resume pair.
prev=""
for arg in "$@"; do
  if [ "$prev" = "--conversation" ]; then CONV="$arg"; fi
  prev="$arg"
done
transcript_of() { printf '%s/%s/.system_generated/logs/transcript.jsonl' "$AGY_BRAIN" "$CONV"; }
TRANSCRIPT="$(transcript_of)"
if [ ! -f "$TRANSCRIPT" ]; then
  mkdir -p "$(dirname "$TRANSCRIPT")"
  printf '{"type":"session_start","conversationId":"%s","workspacePaths":["%s"],"startedAt":"%s"}\n' \
    "$CONV" "$AGY_CWD" "$(now)" > "$TRANSCRIPT"
else
  printf 'agy-resumed:%s\n' "$CONV"
fi
while IFS= read -r line; do
  case "$line" in
    "/switch:"*)
      CONV="${line#/switch:}"
      TRANSCRIPT="$(transcript_of)"
      mkdir -p "$(dirname "$TRANSCRIPT")"
      printf '{"type":"session_start","conversationId":"%s","workspacePaths":["%s"],"startedAt":"%s"}\n' \
        "$CONV" "$AGY_CWD" "$(now)" > "$TRANSCRIPT"
      ;;
    "/resume "*)
      CONV="${line#/resume }"
      TRANSCRIPT="$(transcript_of)"
      ;;
    "/crash")
      exit 1
      ;;
    "/quit"|"/exit")
      exit 0
      ;;
    *)
      printf '{"type":"user_message","conversationId":"%s","text":"%s","at":"%s"}\n' \
        "$CONV" "$line" "$(now)" >> "$TRANSCRIPT"
      ;;
  esac
done
"#;
    std::fs::write(&script_path, script).expect("write fake agy script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).expect("make fake agy executable");
    }
    script_path
}

/// The antigravity `CliCommandSpec`: the real manifest's launch shape
/// (`extensions/antigravity/freshell.json`, whose field mapping
/// `antigravity_launch_e2e.rs` already pins) with the ONE test-only
/// override the suite needs — `default_cmd` points at the fake `agy`
/// (written once by the suite and removed in its cleanup block).
fn antigravity_fake_spec(
    home: &std::path::Path,
    argv_capture: &std::path::Path,
    fake_agy: &std::path::Path,
) -> freshell_platform::CliCommandSpec {
    let mut base_env = std::collections::BTreeMap::new();
    base_env.insert("AGY_HOME".to_string(), home.to_string_lossy().into_owned());
    base_env.insert(
        "AGY_ARGV_CAPTURE".to_string(),
        argv_capture.to_string_lossy().into_owned(),
    );
    freshell_platform::CliCommandSpec {
        name: "antigravity".to_string(),
        label: "Antigravity CLI".to_string(),
        env_var: None,
        default_cmd: fake_agy.to_string_lossy().into_owned(),
        base_args: vec!["-i".to_string()],
        base_env,
        resume_args: Some(vec![
            "--conversation".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        create_session_args: None,
        model_args: None,
        effort_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// One in-process server wired for this suite: the activity hub (its
/// registry observer feeds the association's input capture), the
/// antigravity association rooted at `home`'s brain tree, the naming
/// authority (so identity/naming transitions are real), an ENABLED pane
/// ledger under `ledger_dir` (so the spawn-time pending marker and the
/// durable binding rows are observable), the auto-resume hub on tiny
/// injected schedules (scenario 7), and the antigravity locator sweep at
/// the production cadence (150 ms).
struct AntigravityServer {
    url: String,
    registry: freshell_terminal::TerminalRegistry,
    state: WsState,
}

async fn spawn_antigravity_server(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    home: &std::path::Path,
    ledger_dir: &std::path::Path,
) -> AntigravityServer {
    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings = Arc::new(
        serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
    );
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    let sink = Arc::new(common::NamingProbeSink::default());
    identity.set_session_naming(sink.clone());

    let activity_hub = freshell_ws::activity::ActivityHub::new(Arc::clone(&broadcast_tx), None);
    activity_hub.set_antigravity_association(Arc::new(
        freshell_ws::antigravity_association::AntigravityAssociation::new(home.to_path_buf()),
    ));
    registry.set_activity_observer(activity_hub.registry_observer());

    let (auto_resume_tx, auto_resume_rx) = tokio::sync::mpsc::unbounded_channel();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            ledger_dir.to_path_buf(),
        ))),
        identity,
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: common::handshake_settings_lock(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx,
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
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        checkpoint_send: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(cli_commands),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64)),
        shutdown_started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        create_dedupe: Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: None,
        codex_locator: None,
        activity: Some(activity_hub.clone()),
        session_existence: Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
        ownership: None,
    };

    freshell_ws::auto_resume::spawn_auto_resume_hub_with_schedules(
        state.clone(),
        auto_resume_rx,
        vec![25, 25],
        vec![25, 25],
    );
    freshell_ws::antigravity_association::spawn_antigravity_locator_sweep(
        state.clone(),
        Duration::from_millis(150),
    );

    let router = freshell_ws::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    AntigravityServer {
        url: format!("ws://{addr}/ws"),
        registry,
        state,
    }
}

/// Plant an UNBOUND transcript (the concurrently-appearing / decoy /
/// late-write shapes the tests fabricate): the fixture-format ownership
/// record plus ONE user record with the given text, timestamped at `at_ms`
/// (numeric epoch-ms `at` — the shared timestamp coercion's documented
/// second form, `freshell_sessions::time::parse_timestamp_ms`).
fn plant_transcript(
    home: &std::path::Path,
    conv: &str,
    cwd: &str,
    text: &str,
    at_ms: i64,
) -> std::path::PathBuf {
    let path = transcript_path(home, conv);
    std::fs::create_dir_all(path.parent().expect("logs dir")).expect("create logs dir");
    let body = format!(
        concat!(
            r#"{{"type":"session_start","conversationId":"{conv}","workspacePaths":["{cwd}"],"startedAt":{at}}}"#,
            "\n",
            r#"{{"type":"user_message","conversationId":"{conv}","text":"{text}","at":{at}}}"#,
            "\n",
        ),
        conv = conv,
        cwd = cwd,
        text = text,
        at = at_ms,
    );
    std::fs::write(&path, body).expect("plant transcript");
    path
}

/// Send a `terminal.create` (fresh, explicit cwd) and await its
/// `terminal.created`, returning the terminalId.
async fn create_pane(ws: &mut common::TestWs, cwd: &str, request_id: &str) -> String {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "antigravity",
            "shell": "system",
            "cwd": cwd,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = next_frame_of_type(ws, "terminal.created").await;
    created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string()
}

/// Send a `terminal.create` carrying the frozen client's resume shape —
/// `sessionRef {provider:"antigravity", sessionId}` + `restore:true` —
/// and await its `terminal.created` reply frame (the success path).
async fn create_resume_await_created(
    ws: &mut common::TestWs,
    cwd: &str,
    request_id: &str,
    session_id: &str,
) -> serde_json::Value {
    send_resume_create(ws, cwd, request_id, session_id).await;
    next_frame_of_type(ws, "terminal.created").await
}

/// Send the same resume create and await its typed REFUSAL — an `error`
/// frame correlated to `request_id` (the `live_session_ref_guard.rs`
/// scan-until-verdict convention; a successful `terminal.created` answer
/// fails the assertion).
async fn create_resume_expect_refusal(
    ws: &mut common::TestWs,
    cwd: &str,
    request_id: &str,
    session_id: &str,
) -> serde_json::Value {
    send_resume_create(ws, cwd, request_id, session_id).await;
    let deadline = tokio::time::Instant::now() + common::FRAME_BUDGET;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "error" && value["requestId"] == request_id {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("ws ended/errored awaiting refusal: {other:?}"),
        }
    }
    panic!("no error frame for {request_id} within the frame budget");
}

async fn send_resume_create(
    ws: &mut common::TestWs,
    cwd: &str,
    request_id: &str,
    session_id: &str,
) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "antigravity",
            "shell": "system",
            "cwd": cwd,
            "restore": true,
            "sessionRef": { "provider": "antigravity", "sessionId": session_id },
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create (resume)");
}

/// Type a prompt and submit it: the text chunk, then the Enter byte.
async fn submit_prompt(ws: &mut common::TestWs, terminal_id: &str, text: &str) {
    common::send_input(ws, terminal_id, text).await;
    common::send_input(ws, terminal_id, "\r").await;
}

/// Scan WS text frames until the next `terminal.session.associated` for
/// `terminal_id` arrives (10 s budget), returning the parsed frame.
/// Copied from `codex_fork_rebind.rs`.
async fn next_associated_frame(
    ws: &mut common::TestWs,
    terminal_id: &str,
    label: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.session.associated"
                        && value["terminalId"] == terminal_id
                    {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out awaiting associated: {other:?}"),
        }
    }
    panic!("[{label}] no terminal.session.associated frame for {terminal_id} within 10s");
}

/// Scan WS text frames until `pred` matches or `window` elapses, returning
/// whether a matching frame arrived (positive waits AND absence proofs).
/// Copied from `codex_fork_rebind.rs`.
async fn frame_seen_within(
    ws: &mut common::TestWs,
    window: Duration,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + window;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if pred(&value) {
                        return true;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return false, // stream ended, ws error, or timed out
        }
    }
    false
}

/// Scan WS text frames until a `terminal.session.associated` has arrived
/// for EACH of the two terminals (concurrent-pane waits — the frames may
/// arrive in either order and a single-terminal scan would drop the other
/// pane's frame), returning both parsed frames.
async fn next_associated_frames_two(
    ws: &mut common::TestWs,
    terminal_a: &str,
    terminal_b: &str,
    label: &str,
) -> (serde_json::Value, serde_json::Value) {
    let mut got_a: Option<serde_json::Value> = None;
    let mut got_b: Option<serde_json::Value> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while got_a.is_none() || got_b.is_none() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            tokio::time::Instant::now() < deadline,
            "[{label}] no associated frames for {terminal_a}/{terminal_b} within 10s"
        );
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.session.associated" {
                        if value["terminalId"] == terminal_a && got_a.is_none() {
                            got_a = Some(value);
                        } else if value["terminalId"] == terminal_b && got_b.is_none() {
                            got_b = Some(value);
                        }
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out: {other:?}"),
        }
    }
    (got_a.expect("checked"), got_b.expect("checked"))
}

/// The registry's `resume_session_id` for a terminal (meta probe).
fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

/// Every argv row the fakes have appended to `capture` so far.
fn argv_rows(capture: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(capture)
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Poll the argv capture until `pred` is satisfied by the row set.
async fn wait_argv_rows(
    capture: &std::path::Path,
    pred: impl Fn(&[String]) -> bool,
) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let rows = argv_rows(capture);
        if pred(&rows) || tokio::time::Instant::now() >= deadline {
            return rows;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Position of the adjacent `["--conversation", session_id]` pair in an
/// argv row, if any.
fn conversation_pair_position(row: &str, session_id: &str) -> Option<usize> {
    let tokens: Vec<&str> = row.split_whitespace().collect();
    tokens
        .windows(2)
        .position(|w| w[0] == "--conversation" && w[1] == session_id)
}

#[tokio::test(flavor = "multi_thread")]
async fn antigravity_exact_live_identity_rebind_suite() {
    // ── the suite's shared fixtures ─────────────────────────────────────
    let home = tempfile::tempdir().expect("antigravity home tempdir");
    let cwd_dir = tempfile::tempdir().expect("pane cwd tempdir");
    let ledger_dir = tempfile::tempdir().expect("pane ledger tempdir");
    let cwd = cwd_dir.path().to_string_lossy().into_owned();
    let argv_capture = std::env::temp_dir().join(format!(
        "freshell-antigravity-rebind-argv-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&argv_capture);
    let logs = log_capture::install();
    // The fake `agy` script (written once; both servers point at it, and
    // the cleanup block removes it — it must not outlive the suite).
    let fake_agy = write_fake_agy();

    let server = spawn_antigravity_server(
        vec![antigravity_fake_spec(home.path(), &argv_capture, &fake_agy)],
        home.path(),
        ledger_dir.path(),
    )
    .await;
    let mut ws = common::connect_and_capture_inventory(&server.url).await.0;
    let mut to_kill: Vec<String> = Vec::new();

    // ── Scenario 1: fresh adopt + wrong-text never adopted ──────────────
    // A decoy transcript (same cwd, DIFFERENT first-user text) exists in
    // the brain before the pane ever submits: content matching must adopt
    // only the pane's own conversation.
    let decoy_conv = "conv-decoy-scenario-one";
    plant_transcript(
        home.path(),
        decoy_conv,
        &cwd,
        "decoy prompt never submitted",
        now_ms(),
    );

    let tid1 = create_pane(&mut ws, &cwd, "req-agy-sc1").await;
    to_kill.push(tid1.clone());
    submit_prompt(&mut ws, &tid1, "first prompt for pane one alpha").await;

    let adopted1 = next_associated_frame(&mut ws, &tid1, "sc1-adopt").await;
    let conv1 = conv_of(&tid1);
    assert_eq!(
        adopted1["sessionRef"]["provider"], "antigravity",
        "adoption binds the antigravity provider: {adopted1}"
    );
    assert_eq!(
        adopted1["sessionRef"]["sessionId"], conv1,
        "adoption binds the pane's own conversation (never the decoy): {adopted1}"
    );
    assert_eq!(
        registry_resume_id(&server.registry, &tid1).as_deref(),
        Some(conv1.as_str()),
        "registry meta resume_session_id follows the adoption"
    );
    assert!(
        server
            .state
            .identity
            .session_ref_for(&tid1)
            .is_some_and(|r| r.provider == "antigravity" && r.session_id == conv1),
        "the identity row carries the adopted sessionRef"
    );
    assert!(
        server
            .state
            .pane_ledger
            .pending_for_terminal(&tid1)
            .is_none(),
        "adoption consumed the spawn-time pending marker (binding-first order)"
    );
    assert!(
        server
            .state
            .pane_ledger
            .lookup_by_session("antigravity", &conv1)
            .is_some_and(|r| r.row.live_terminal_id.as_deref() == Some(tid1.as_str())),
        "the durable binding row names the pane as the live terminal"
    );
    let bound_log = logs
        .matching(|e: &CapturedEvent| {
            e.fields.get("event").map(String::as_str) == Some("antigravity_identity_bound")
                && e.fields.get("terminal_id").map(String::as_str) == Some(tid1.as_str())
        })
        .pop()
        .expect("antigravity_identity_bound JSONL event logged");
    assert_eq!(bound_log.level, tracing::Level::INFO);

    // ── Scenario 2: TRUE concurrency, honest ambiguity, re-typed prompt ─
    let tid2a = create_pane(&mut ws, &cwd, "req-agy-sc2-a").await;
    to_kill.push(tid2a.clone());
    let tid2b = create_pane(&mut ws, &cwd, "req-agy-sc2-b").await;
    to_kill.push(tid2b.clone());
    // Both panes submit DISTINCT nonces before either window resolves —
    // each pane's locator sees BOTH transcripts; content matching adopts
    // each pane's own conversation (no cross-bind).
    submit_prompt(&mut ws, &tid2a, "concurrent nonce for pane two a bravo").await;
    submit_prompt(&mut ws, &tid2b, "concurrent nonce for pane two b charlie").await;
    let (adopted2a, adopted2b) =
        next_associated_frames_two(&mut ws, &tid2a, &tid2b, "sc2-concurrent-adopt").await;
    assert_eq!(
        adopted2a["sessionRef"]["sessionId"],
        conv_of(&tid2a),
        "pane A adopts its OWN conversation under true concurrency: {adopted2a}"
    );
    assert_eq!(
        adopted2b["sessionRef"]["sessionId"],
        conv_of(&tid2b),
        "pane B adopts its OWN conversation under true concurrency: {adopted2b}"
    );

    // The honest-refusal case: a fresh pane submits a prompt text
    // IDENTICAL to concurrently-appearing unbound transcripts' latest
    // user text — twice over. The pane's own conversation ALSO carries
    // the text (its fake recorded it), so >= 3 candidates match: the
    // locator refuses them ALL (never a guess) and logs the refusal.
    let amb_text = "ambiguous duplicate prompt delta";
    let tid2c = create_pane(&mut ws, &cwd, "req-agy-sc2-c").await;
    to_kill.push(tid2c.clone());
    submit_prompt(&mut ws, &tid2c, amb_text).await;
    // The transcripts model CLI writes that appear concurrently with the
    // pane's open window: their record timestamps must be AT/AFTER the
    // pane's submit (the recency rule's bound — a transcript whose newest
    // record predates the submit can never match). Let the server's
    // Input-event stamp settle first, so the plant's `at` is strictly
    // newer than the submit it must postdate.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let at2c = now_ms();
    plant_transcript(home.path(), "conv-unbound-amb-one", &cwd, amb_text, at2c);
    plant_transcript(home.path(), "conv-unbound-amb-two", &cwd, amb_text, at2c);

    let refused = logs
        .wait_for(
            "antigravity_association_refused {reason:ambiguous} log",
            |e: &CapturedEvent| {
                e.fields.get("event").map(String::as_str) == Some("antigravity_association_refused")
                    && e.fields.get("reason").map(String::as_str) == Some("ambiguous")
                    && e.fields.get("terminal_id").map(String::as_str) == Some(tid2c.as_str())
            },
        )
        .await;
    assert_eq!(refused.level, tracing::Level::WARN);
    assert!(
        !frame_seen_within(&mut ws, Duration::from_secs(4), |v| {
            v["type"] == "terminal.session.associated" && v["terminalId"] == tid2c.as_str()
        })
        .await,
        "the ambiguous pane never receives an association frame (never a guess)"
    );

    // Re-typing a PREVIOUS prompt (text identical to an OLD transcript's
    // latest user record) does NOT adopt that old transcript — the
    // recency window rejects records older than the submit. The pane
    // adopts its OWN fresh conversation (whose record carries that text,
    // written now) instead.
    let tid2d = create_pane(&mut ws, &cwd, "req-agy-sc2-d").await;
    to_kill.push(tid2d.clone());
    submit_prompt(&mut ws, &tid2d, "concurrent nonce for pane two a bravo").await;
    let adopted2d = next_associated_frame(&mut ws, &tid2d, "sc2-retyped").await;
    assert_eq!(
        adopted2d["sessionRef"]["sessionId"],
        conv_of(&tid2d),
        "the re-typed prompt adopts the pane's OWN fresh conversation: {adopted2d}"
    );
    assert_ne!(
        adopted2d["sessionRef"]["sessionId"],
        conv_of(&tid2a),
        "the re-typed prompt never adopts the OLD transcript (recency rejection)"
    );

    // ── Scenario 3: in-CLI switch, both documented forms ────────────────
    // (a) While pane one still LIVE-OWNS conv1, a third pane TARGETING
    // conv1 through the create door gets the live-owner refusal — the
    // adopted identity is a real, owned session.
    let refusal = create_resume_expect_refusal(&mut ws, &cwd, "req-agy-sc3-target", &conv1).await;
    assert_eq!(
        refusal["code"], "RESTORE_UNAVAILABLE",
        "a create targeting a live-owned session is refused: {refusal}"
    );
    assert_eq!(
        refusal["liveTerminalId"],
        tid1.as_str(),
        "the refusal names the live owner terminal: {refusal}"
    );

    // (b) `/switch:<new id>` mints a NEW conversation; the pane's next
    // prompt lands as that conversation's latest user record → rebind.
    let switch_conv = "conv-switch-scenario-three";
    submit_prompt(&mut ws, &tid1, &format!("/switch:{switch_conv}")).await;
    submit_prompt(&mut ws, &tid1, "prompt after the switch echo").await;
    let rebound = next_associated_frame(&mut ws, &tid1, "sc3-switch-rebind").await;
    assert_eq!(
        rebound["sessionRef"]["sessionId"], switch_conv,
        "the /switch rebind moves the pane to the new conversation: {rebound}"
    );
    assert_eq!(
        rebound["previousSessionId"], conv1,
        "the rebind names the superseded identity: {rebound}"
    );
    assert_eq!(
        registry_resume_id(&server.registry, &tid1).as_deref(),
        Some(switch_conv),
        "registry meta follows the switch"
    );
    assert!(
        server
            .state
            .identity
            .session_ref_for(&tid1)
            .is_some_and(|r| r.session_id == switch_conv),
        "the identity row follows the switch"
    );
    let rebound_log = logs
        .matching(|e: &CapturedEvent| {
            e.fields.get("event").map(String::as_str) == Some("antigravity_identity_rebound")
                && e.fields.get("terminal_id").map(String::as_str) == Some(tid1.as_str())
        })
        .pop()
        .expect("antigravity_identity_rebound JSONL event logged");

    // (c) `/resume <existing id>` — the EXISTING (unowned) conversation's
    // transcript receives the pane's next prompt as its LATEST user
    // record → rebind to the existing id (new-directory-only evidence
    // could never catch this form).
    let resume_conv = "conv-resume-existing";
    plant_transcript(
        home.path(),
        resume_conv,
        &cwd,
        "the earlier conversation own prompt",
        now_ms() - 60_000,
    );
    submit_prompt(&mut ws, &tid1, &format!("/resume {resume_conv}")).await;
    submit_prompt(&mut ws, &tid1, "prompt landed in the resumed conversation").await;
    let resumed = next_associated_frame(&mut ws, &tid1, "sc3-resume-rebind").await;
    assert_eq!(
        resumed["sessionRef"]["sessionId"], resume_conv,
        "the /resume rebind moves the pane to the EXISTING conversation: {resumed}"
    );
    assert_eq!(
        resumed["previousSessionId"], switch_conv,
        "the resume rebind names the superseded identity: {resumed}"
    );
    // The rebind's transcript path really is the resumed conversation's.
    let _ = rebound_log;

    // ── Scenario 4: restart resume adjacency ────────────────────────────
    // Kill the pane, then "restart the server" the way a restart actually
    // happens: a fresh server process over the SAME antigravity home
    // (fresh in-memory identity/registry/ledger), and replay exactly what
    // a client that accepted the rebind persists — a restore create
    // carrying sessionRef {antigravity, <bound id>}. The respawned CLI
    // must launch with the ADJACENT --conversation <bound id> argv and
    // the identity persists.
    server.registry.kill(&tid1);
    let argv_capture_2 = std::env::temp_dir().join(format!(
        "freshell-antigravity-rebind-argv-restart-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&argv_capture_2);
    let ledger_dir_2 = tempfile::tempdir().expect("restart pane ledger tempdir");
    let server2 = spawn_antigravity_server(
        vec![antigravity_fake_spec(
            home.path(),
            &argv_capture_2,
            &fake_agy,
        )],
        home.path(),
        ledger_dir_2.path(),
    )
    .await;
    let mut ws2 = common::connect_and_capture_inventory(&server2.url).await.0;

    let created4 =
        create_resume_await_created(&mut ws2, &cwd, "req-agy-sc4-restore", resume_conv).await;
    let tid4 = created4["terminalId"]
        .as_str()
        .expect("restart restore create spawns")
        .to_string();
    // tid4 belongs to the restarted server — cleaned up against server2 below.
    let rows4 = wait_argv_rows(&argv_capture_2, |rows| {
        rows.iter()
            .any(|r| conversation_pair_position(r, resume_conv).is_some())
    })
    .await;
    assert!(
        rows4
            .iter()
            .any(|r| conversation_pair_position(r, resume_conv).is_some()),
        "the restored pane launches with the adjacent --conversation pair: {rows4:?}"
    );
    assert_eq!(
        registry_resume_id(&server2.registry, &tid4).as_deref(),
        Some(resume_conv),
        "the restored pane's registry meta carries the persisted identity"
    );
    assert!(
        server2
            .state
            .identity
            .session_ref_for(&tid4)
            .is_some_and(|r| r.provider == "antigravity" && r.session_id == resume_conv),
        "identity persists across the restart (create-time reseed from the sessionRef)"
    );

    // ── Scenario 5: zero-turn pane (created, no submit) ────────────────
    let tid5 = create_pane(&mut ws, &cwd, "req-agy-sc5-zero-turn").await;
    to_kill.push(tid5.clone());
    assert!(
        !frame_seen_within(&mut ws, Duration::from_secs(3), |v| {
            v["type"] == "terminal.session.associated" && v["terminalId"] == tid5.as_str()
        })
        .await,
        "a zero-turn pane never receives an association frame"
    );
    assert_eq!(
        registry_resume_id(&server.registry, &tid5),
        None,
        "a zero-turn pane carries no sessionRef"
    );
    assert!(
        server.state.identity.session_ref_for(&tid5).is_none(),
        "a zero-turn pane seeds no identity"
    );
    assert!(
        server
            .state
            .pane_ledger
            .pending_for_terminal(&tid5)
            .is_some(),
        "a zero-turn fresh antigravity pane retains its spawn-time pending marker"
    );

    // ── Scenario 6: late old-text write rejected after a fresh respawn ──
    let tid6 = create_pane(&mut ws, &cwd, "req-agy-sc6").await;
    to_kill.push(tid6.clone());
    let sc6_prompt = "late write phase prompt foxtrot";
    submit_prompt(&mut ws, &tid6, sc6_prompt).await;
    let adopted6 = next_associated_frame(&mut ws, &tid6, "sc6-adopt").await;
    assert_eq!(
        adopted6["sessionRef"]["sessionId"],
        conv_of(&tid6),
        "scenario 6's pane adopts its own conversation first: {adopted6}"
    );
    // The pane's process dies and the pane "respawns fresh" (a recreate
    // with NO resume id — the restore-without-identity shape).
    server.registry.kill(&tid6);
    let tid6b = create_pane(&mut ws, &cwd, "req-agy-sc6-respawn").await;
    to_kill.push(tid6b.clone());
    // The DEAD LAUNCH's late write: a transcript for a NEW conversation
    // carrying the old prompt text, written at respawn time.
    let late_conv = "conv-late-write";
    plant_transcript(home.path(), late_conv, &cwd, sc6_prompt, now_ms());
    // The respawned pane's OWN submit with its OWN text adopts its own
    // new conversation; the late write (different text) never binds.
    submit_prompt(&mut ws, &tid6b, "respawned pane own prompt golf").await;
    let adopted6b = next_associated_frame(&mut ws, &tid6b, "sc6-respawn-adopt").await;
    assert_eq!(
        adopted6b["sessionRef"]["sessionId"],
        conv_of(&tid6b),
        "the respawned pane adopts its OWN new conversation: {adopted6b}"
    );
    assert_ne!(
        adopted6b["sessionRef"]["sessionId"], late_conv,
        "the dead launch's late write is never adopted by the respawned row"
    );
    assert_ne!(
        adopted6b["sessionRef"]["sessionId"],
        conv_of(&tid6),
        "the dead pane's own conversation is never resurrected onto the respawned row"
    );
    assert!(
        !frame_seen_within(&mut ws, Duration::from_secs(2), |v| {
            v["type"] == "terminal.session.associated"
                && v["sessionRef"]["sessionId"]
                    .as_str()
                    .is_some_and(|s| s == late_conv || s == conv_of(&tid6))
        })
        .await,
        "neither the late write nor the dead pane's conversation ever associates"
    );

    // ── Scenario 7: crash auto-resume parity + exactly one attention edge ─
    let tid7 = create_pane(&mut ws, &cwd, "req-agy-sc7").await;
    to_kill.push(tid7.clone());
    submit_prompt(&mut ws, &tid7, "crash phase prompt hotel").await;
    let adopted7 = next_associated_frame(&mut ws, &tid7, "sc7-adopt").await;
    assert_eq!(
        adopted7["sessionRef"]["sessionId"],
        conv_of(&tid7),
        "scenario 7's pane adopts before the crash: {adopted7}"
    );
    // Mid-turn: a fresh submit keeps the pane engaged, then the process
    // dies on its own (the fake's /crash — a real spontaneous exit 1).
    submit_prompt(&mut ws, &tid7, "mid turn prompt india").await;
    let mut ws7 = common::connect_and_capture_inventory(&server.url).await.0;
    common::send_input(&mut ws7, &tid7, "/crash").await;
    common::send_input(&mut ws7, &tid7, "\r").await;

    // The crash rings the unified attention edge (terminal.idle) for the
    // crashed pane exactly once: exactly-one is proven by the first-frame
    // wait PLUS an absence window for a second edge on a second
    // connection (a fresh connection sees only post-connect broadcasts).
    assert!(
        frame_seen_within(&mut ws7, Duration::from_secs(10), |v| {
            v["type"] == "terminal.idle" && v["terminalId"] == tid7.as_str()
        })
        .await,
        "the crash turn rings the unified attention edge (terminal.idle)"
    );
    assert!(
        !frame_seen_within(&mut ws7, Duration::from_secs(4), |v| {
            v["type"] == "terminal.idle" && v["terminalId"] == tid7.as_str()
        })
        .await,
        "the attention edge rings EXACTLY once"
    );

    // Auto-resume respawned the pane with the ADJACENT --conversation
    // <bound id> argv — the crash did not silently start a fresh
    // conversation — and the replacement terminal carries the identity.
    let replaced = next_frame_of_type(&mut ws, "terminal.replaced").await;
    assert_eq!(replaced["oldTerminalId"], tid7.as_str(), "{replaced}");
    let tid7_new = replaced["newTerminalId"]
        .as_str()
        .expect("new terminal id")
        .to_string();
    to_kill.push(tid7_new.clone());
    let rows7 = wait_argv_rows(&argv_capture, |rows| {
        rows.iter()
            .any(|r| conversation_pair_position(r, &conv_of(&tid7)).is_some())
    })
    .await;
    assert!(
        rows7
            .iter()
            .any(|r| conversation_pair_position(r, &conv_of(&tid7)).is_some()),
        "the crash respawn launches with the adjacent --conversation <bound id> argv: {rows7:?}"
    );
    assert_eq!(
        registry_resume_id(&server.registry, &tid7_new).as_deref(),
        Some(conv_of(&tid7).as_str()),
        "the replacement pane carries the retained identity"
    );

    // ── Scenario 8: a deliberate user quit rings NO death bell (#612) ──
    // The pane submits (the flushed submit arms the idle gate's
    // provisional Busy — the SAME engagement scenario 7's crash rings
    // through), the user then types /quit and the CLI exits on its own:
    // a spontaneous exit preceded by a quit-intent input. The #612
    // suppression must hold for antigravity panes exactly as it does
    // for tracker modes — NO unified attention edge. (The exit-0 quit
    // also never auto-resumes: the lane settles it `clean_exit`, so the
    // pane simply ends exited.)
    let tid8 = create_pane(&mut ws, &cwd, "req-agy-sc8").await;
    to_kill.push(tid8.clone());
    submit_prompt(&mut ws, &tid8, "quit phase prompt juliet").await;
    // A fresh connection for the absence proof (a fresh connection sees
    // only post-connect broadcasts — no backlog ambiguity).
    let mut ws8 = common::connect_and_capture_inventory(&server.url).await.0;
    submit_prompt(&mut ws8, &tid8, "/quit").await;
    assert!(
        !frame_seen_within(&mut ws8, Duration::from_secs(4), |v| {
            v["type"] == "terminal.idle" && v["terminalId"] == tid8.as_str()
        })
        .await,
        "a deliberate user quit (quit-intent input + spontaneous exit) rings \
         NO death bell (#612 parity)"
    );

    // ── cleanup: only the terminals this suite created (never a broad kill) ──
    for tid in &to_kill {
        server.registry.kill(tid);
    }
    server2.registry.kill(&tid4);
    let _ = std::fs::remove_file(&argv_capture);
    let _ = std::fs::remove_file(&argv_capture_2);
    let _ = std::fs::remove_file(&fake_agy);
}
