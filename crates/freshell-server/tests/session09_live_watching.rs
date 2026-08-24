//! SESSION-09 outer acceptance test (black-box, WS-wire depth): boots the
//! REAL `freshell-server` binary against an isolated temp home with an EMPTY
//! claude provider root, connects an authenticated `/ws` client, and drives
//! every live-watching change class through real on-disk mutations — create,
//! modified (max-moving append), the SESSION-16 handoff's hidden→visible flip
//! (NO timestamp/count movement at all — only `is_non_interactive` flips),
//! delete, and a 5-append burst — asserting each time that a `sessions.changed`
//! frame arrives live (no restart, no polling via HTTP required), before any
//! client HTTP refetch happens for that leg.
//!
//! `session_index`/`spawn_sessions_sweep` in-crate pins (main.rs
//! `sessions_sweep_tests`) cover the digest semantics per field; THIS file is
//! the assembled proof that the sweep → `broadcast_sessions_changed` → wire
//! frame path actually fires in the real binary.
//!
//! Harness conventions intentionally duplicated from
//! `diag01_lifecycle_logging.rs` / `safe11_term22_shutdown_reaping.rs` (this
//! repo's black-box test files each carry their own small copy).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

const AUTH_TOKEN: &str = "session09-live-watching-test-secret-2bfa41";

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ── binary + boot harness ────────────────────────────────────────────────

fn discover_server_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("FRESHELL_SERVER_BIN") {
        return PathBuf::from(explicit);
    }
    let suffix = std::env::consts::EXE_SUFFIX;
    if let Some(found) = find_sibling(suffix) {
        return found;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new(env!("CARGO"))
        .args(["build", "--bin", "freshell-server"])
        .current_dir(&manifest_dir)
        .status()
        .expect("spawn `cargo build --bin freshell-server`");
    assert!(status.success(), "cargo build --bin freshell-server failed");
    find_sibling(suffix).expect("freshell-server binary not found even after building it")
}

fn find_sibling(suffix: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for dir in exe.ancestors().skip(1).take(3) {
        let candidate = dir.join(format!("freshell-server{suffix}"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn allocate_ephemeral_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

async fn wait_for_health(port: u16, child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let url = format!("http://127.0.0.1:{port}/api/health");
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return false;
        }
        if let Ok(resp) = reqwest::Client::new().get(&url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

struct Boot {
    child: Child,
    port: u16,
}

async fn boot_server(server_binary: &std::path::Path, home: &std::path::Path) -> Boot {
    let port = allocate_ephemeral_port();
    let mut child = Command::new(server_binary)
        .env("PORT", port.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_BIND_HOST", "127.0.0.1")
        .env("FRESHELL_HOME", home)
        .env("HOME", home)
        // Full provider-home hermeticity (mirrors the e2e harness's
        // `applyIsolatedHomeEnvironment`): the sweep under test indexes the
        // REAL provider roots, so every provider override env must land
        // inside the temp home or be stripped, or an ambient developer home
        // leaks into the corpus and destabilizes the quiet/no-spurious legs.
        .env("CLAUDE_HOME", home.join(".claude"))
        .env("CODEX_HOME", home.join(".codex"))
        .env("XDG_DATA_HOME", home.join(".local").join("share"))
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("FRESHELL_AMPLIFIER_HOME")
        .env_remove("FRESHELL_APP_VERSION")
        .env_remove("RUST_LOG")
        .env_remove("FRESHELL_LOG_DIR")
        .env_remove("FRESHELL_LOG_MAX_BYTES")
        .env_remove("FRESHELL_LOG_MAX_BACKUPS")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server");
    assert!(
        wait_for_health(port, &mut child, Duration::from_secs(20)).await,
        "freshell-server never became healthy on port {port}"
    );
    Boot { child, port }
}

// ── corpus writers (shape proven by main.rs `sessions_sweep_tests` and
// `directory_index`'s `claude_home_with` fixtures) ───────────────────────

fn write_claude_session(file: &Path, session_id: &str, cwd: &str, timestamp: &str) {
    let line = serde_json::json!({
        "type": "user",
        "sessionId": session_id,
        "cwd": cwd,
        "message": { "role": "user", "content": "first user request" },
        "timestamp": timestamp,
    })
    .to_string();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, format!("{line}\n")).unwrap();
}

fn append_user_line(file: &Path, session_id: &str, cwd: &str, timestamp: &str, content: &str) {
    let line = serde_json::json!({
        "type": "user",
        "sessionId": session_id,
        "cwd": cwd,
        "message": { "role": "user", "content": content },
        "timestamp": timestamp,
    })
    .to_string();
    let mut f = std::fs::OpenOptions::new().append(true).open(file).unwrap();
    f.write_all(format!("{line}\n").as_bytes()).unwrap();
}

// ── ws helpers ───────────────────────────────────────────────────────────

async fn send_json(ws: &mut WsStream, value: &serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("ws send");
}

/// Read frames until `deadline`, returning every `sessions.changed` revision
/// observed (any other frame types — ready/pong/etc. — are skipped). Used
/// BOTH for "a frame must arrive" legs (with a short-circuit caller-side
/// break) and "no frame must arrive" quiet windows (assert the vec is empty).
async fn collect_changed_until(
    ws: &mut WsStream,
    deadline: Instant,
    stop_after_first: bool,
) -> Vec<i64> {
    let mut revisions = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return revisions;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value.get("type").and_then(|t| t.as_str()) == Some("sessions.changed") {
                        revisions.push(
                            value
                                .get("revision")
                                .and_then(|r| r.as_i64())
                                .expect("sessions.changed carries a numeric revision"),
                        );
                        if stop_after_first {
                            return revisions;
                        }
                    }
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => panic!("ws read error: {e}"),
            Ok(None) => panic!("ws closed unexpectedly mid-test"),
            Err(_) => return revisions, // window elapsed
        }
    }
}

/// The one shared assertion for every "must broadcast" leg: mutating the
/// corpus at time M must yield a `sessions.changed` frame at-or-before
/// M + `within`, and its revision must EXCEED the previous leg's (the
/// unified `sessions_revision` counter — `main.rs`, SESSION-09 fix-forward
/// — is strictly monotonic, so a stale/replayed frame from an earlier leg
/// can never satisfy a later one).
async fn expect_change_frame(
    ws: &mut WsStream,
    prev_revision: i64,
    within: Duration,
    leg: &str,
) -> i64 {
    let deadline = Instant::now() + within;
    let observed = collect_changed_until(ws, deadline, true).await;
    let first = observed.first().copied().unwrap_or_else(|| {
        panic!("{leg}: no sessions.changed frame within {within:?} of the corpus mutation")
    });
    assert!(
        first > prev_revision,
        "{leg}: frame revision {first} must exceed previous leg's {prev_revision} (monotonic unified counter)"
    );
    first
}

async fn expect_quiet(ws: &mut WsStream, window: Duration, leg: &str) {
    let observed = collect_changed_until(ws, Instant::now() + window, false).await;
    assert!(
        observed.is_empty(),
        "{leg}: expected NO sessions.changed frames within {window:?} of quiescence, got {observed:?}"
    );
}

// ── the acceptance test ──────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session09_live_watch_and_coalescing_over_ws() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let claude_projects = home.path().join(".claude").join("projects").join("-p");

    // Anchor session, seeded BEFORE boot: sits at a FUTURE corpus max
    // (2030) so later mid-test appends to other sessions (2026 range) keep
    // the corpus max unmoved — making the old (len, max) signature
    // provably blind to those legs, and this test a genuine pin of the new
    // full-comparable digest rather than a tautology the old code would
    // also pass. Because it exists before the sweep's boot-seed snapshot,
    // it generates no spurious boot frame.
    write_claude_session(
        &claude_projects.join("a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0.jsonl"),
        "a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0",
        "/tmp/s09-live/anchor",
        "2030-01-01T00:00:00.000Z",
    );

    let mut boot = boot_server(&server_binary, home.path()).await;

    // WS handshake: hello → ready (auth via token, matching the client).
    let ws_url = format!("ws://127.0.0.1:{}/ws", boot.port);
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("ws connect");
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "hello",
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "token": AUTH_TOKEN,
        }),
    )
    .await;
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut got_ready = false;
        while Instant::now() < deadline && !got_ready {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, ws.next()).await {
                Ok(Some(Ok(WsMessage::Text(text)))) => {
                    if text.contains("\"ready\"") {
                        got_ready = true;
                    }
                }
                Ok(Some(Ok(_))) => continue,
                other => panic!("never received ready frame: {other:?}"),
            }
        }
        assert!(got_ready, "expected `ready` handshake frame");
    }

    // Leg 0 — QUIET BOOT: an untouched home must produce NO spurious
    // `sessions.changed` frames across >3 sweep ticks (sweep seeds its
    // signature from the boot corpus before the loop; any broadcast here
    // means a boot-seed or spurious-change defect). 6.5s window also covers
    // the locator/identity sweeps which share the bus but must never mint
    // sessions.revision frames on an idle empty corpus.
    expect_quiet(&mut ws, Duration::from_millis(6500), "quiet boot").await;

    // Leg 1 — CREATE: a brand-new session file lands in the watched root.
    let session_a = format!(
        "{}/{}",
        claude_projects.display(),
        "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl"
    );
    write_claude_session(
        Path::new(&session_a),
        "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        "/tmp/s09-live/alpha",
        "2026-01-01T00:00:00.000Z",
    );
    let r1 = expect_change_frame(&mut ws, 0, Duration::from_secs(10), "create").await;
    // A second identical write that changes NOTHING sidebar-visible (same
    // content → same parsed view) must NOT re-broadcast — the sweep is a
    // change detector, not a poll-notifier.
    write_claude_session(
        Path::new(&session_a),
        "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        "/tmp/s09-live/alpha",
        "2026-01-01T00:00:00.000Z",
    );
    expect_quiet(
        &mut ws,
        Duration::from_millis(5000),
        "content-identical rewrite",
    )
    .await;

    // Leg 2 — MODIFIED BELOW THE CORPUS MAX: append a newer-timestamp turn
    // (2026) to the SAME file while the anchor sits at 2030. NEITHER corpus
    // len NOR corpus max moves here — the old (len, max, identity) sweep
    // signature was PROVABLY BLIND to this exact class; the frame arrives
    // only because the digest covers the session's own `last_activity_at`.
    // (Sibling in-crate pin: `in_place_modification_below_corpus_max_moves_the_signature`.)
    append_user_line(
        Path::new(&session_a),
        "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        "/tmp/s09-live/alpha",
        "2026-01-02T00:00:00.000Z",
        "second turn appended live",
    );
    let r2 = expect_change_frame(&mut ws, r1, Duration::from_secs(10), "modified").await;
    expect_quiet(&mut ws, Duration::from_millis(5000), "post-modified settle").await;

    // Leg 3 — SESSION-16 HANDOFF (visibility flip, the exact blindness the
    // old `(len, max-timestamp, identity)` signature had): a hidden
    // non-interactive session (ONE user message — claude.rs:469
    // `user_message_count <= 1`) gains its SECOND user message with the
    // SAME timestamp. Length unchanged, corpus max unchanged, the session's
    // own `last_activity_at`/`created_at` unchanged — ONLY
    // `is_non_interactive` moves (false ⟵ true), a sidebar-visible change.
    //
    // Step A: the hidden session's CREATE is itself a change (len moves),
    // so consume its frame first to isolate the flip leg.
    let session_h = format!(
        "{}/{}",
        claude_projects.display(),
        "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.jsonl"
    );
    write_claude_session(
        Path::new(&session_h),
        "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        "/tmp/s09-live/hidden",
        "2025-01-01T00:00:00.000Z",
    );
    let r3a = expect_change_frame(&mut ws, r2, Duration::from_secs(10), "hidden create").await;
    expect_quiet(
        &mut ws,
        Duration::from_millis(5000),
        "post-hidden-create settle",
    )
    .await;

    // Step B: the flip. Same-timestamp second user message — every field of
    // the OLD signature is provably unmoved; the frame arrives ONLY because
    // the digest covers `is_non_interactive` (mutation spot-check in the
    // crate pins: dropping that field turns exactly this class red).
    append_user_line(
        Path::new(&session_h),
        "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        "/tmp/s09-live/hidden",
        "2025-01-01T00:00:00.000Z",
        "second user turn makes it interactive",
    );
    let r3 = expect_change_frame(&mut ws, r3a, Duration::from_secs(10), "visibility flip").await;
    expect_quiet(&mut ws, Duration::from_millis(5000), "post-flip settle").await;

    // Leg 4 — DELETE: the flipped session's file is removed.
    std::fs::remove_file(&session_h).unwrap();
    let r4 = expect_change_frame(&mut ws, r3, Duration::from_secs(10), "delete").await;
    expect_quiet(&mut ws, Duration::from_millis(5000), "post-delete settle").await;

    // Leg 5 — COALESCED BURST: five rapid appends inside ~700ms (well
    // inside ONE 2s sweep tick under normal scheduling, and at most
    // straddling TWO ticks under clock skew) must produce a bounded number
    // of broadcasts — legacy parity is leading+trailing ≈ ≤2
    // (`SessionsSyncService`'s 150ms coalesce window) — NOT one per write.
    // After the burst settles there must follow a quiet window: no storm of
    // late frames.
    const BURST: usize = 5;
    for i in 1..=BURST {
        append_user_line(
            Path::new(&session_a),
            "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            "/tmp/s09-live/alpha",
            &format!("2026-02-01T00:00:0{i}.000Z"),
            &format!("burst append {i}"),
        );
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    // Window long enough for ≥2 full sweep ticks post-burst, so any
    // straddle-split second frame must surface inside it.
    let burst_frames =
        collect_changed_until(&mut ws, Instant::now() + Duration::from_secs(7), false).await;
    assert!(
        !burst_frames.is_empty(),
        "burst: at least one sessions.changed frame must observe the burst"
    );
    assert!(
        burst_frames.len() <= 2,
        "burst: 5 appends inside a sweep tick must coalesce to at most 2 frames (straddle bound), got {} (revisions {burst_frames:?})",
        burst_frames.len()
    );
    assert!(
        burst_frames.iter().all(|r| *r > r4),
        "burst: every burst frame must exceed the previous leg's revision {r4}, got {burst_frames:?}"
    );
    // And the stream must go quiet afterwards (no endless re-deliveries).
    expect_quiet(
        &mut ws,
        Duration::from_millis(6000),
        "post-burst quiescence",
    )
    .await;

    // CLEANUP: SIGTERM — the graceful-shutdown contract (shared with
    // safe11's assertions about the same path).
    let rc = unsafe { libc::kill(boot.child.id() as libc::pid_t, libc::SIGTERM) };
    assert_eq!(rc, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match boot.child.try_wait() {
            Ok(Some(status)) => {
                assert!(
                    status.success(),
                    "server must exit 0 on SIGTERM, got {status:?}"
                );
                break;
            }
            Ok(None) => {
                assert!(
                    Instant::now() < deadline,
                    "server did not exit within 5s of SIGTERM"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(e) => panic!("try_wait failed: {e}"),
        }
    }
}
