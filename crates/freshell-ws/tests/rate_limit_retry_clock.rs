//! `rate_limited_retry_same_requestid_proceeds`, moved out of
//! `restore_spawn_gate.rs` into its OWN single-test integration binary:
//! determinism comes from the process-global shared test clock
//! (`freshell_platform::clock`), and overriding a process-global inside a
//! multi-test binary pollutes parallel siblings — the exact reason
//! `test_clock_routing.rs` lives in its own binary (HARNESS-14). Alone in
//! this process, the GateGuard-scoped override cannot cross-contaminate
//! anything.
//!
//! A2 hard requirement (unchanged from the restore_spawn_gate.rs original):
//! a rate-limited create must NOT leave an InFlight sentinel behind. The
//! dedupe `begin` runs at the TOP of the dispatch arm — BEFORE the rate
//! limiter — so the RATE_LIMITED early return must clear the sentinel;
//! otherwise the frozen client's retry with the SAME requestId
//! (TerminalView.tsx:155-157, :3995-3999) is swallowed as DuplicateInFlight
//! forever and the pane wedges.
//!
//! DEFLAKE (the-usual test-flake-hardening, delta-review r2 M3): the earlier
//! forms of this test sized a WALL-CLOCK window around the load-dependent
//! stamp→check gap — the sequential per-connection dispatch stamps rl-1
//! BEFORE its whole spawn (terminal.rs:2589 stamp, :807-880 sequential
//! dispatch), so rl-2's rate check necessarily lands a full spawn+turnaround
//! AFTER rl-1's stamp, and any scheduling stall larger than the window
//! legitimately ACCEPTED rl-2 (certification run 1 of task2-certify.log lost
//! the expected RATE_LIMITED that way at 300ms; the 2_000ms follow-up stayed
//! load-racy in principle). The clock formulation removes the dependence
//! entirely: `freeze()` BEFORE rl-1's send makes rl-1's stamp, rl-2's check,
//! and the twice-limited resend's check all read the SAME frozen instant
//! (deterministic RATE_LIMITED under any load), and one `advance_ms(400)`
//! deterministically slides the 300ms window for the post-window retry. NO
//! wall-clock/tokio sleep paces the rate window; only the frame reads keep
//! their `common::FRAME_BUDGET` deadline budgets. Config stays
//! {rate_limit: 1, rate_window_ms: 300} — determinism comes from the clock,
//! not the count.

mod common;

use std::sync::{Mutex, MutexGuard};

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::create_limit::CreateProtectConfig;

/// Serialize + scope the process-global clock override within THIS binary
/// (copied from test_clock_routing.rs — same process-global hazard, same
/// mutex + reset-on-drop guard shape).
static LOCK: Mutex<()> = Mutex::new(());

struct GateGuard {
    _guard: MutexGuard<'static, ()>,
}

impl GateGuard {
    fn enable() -> Self {
        let guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        freshell_platform::clock::set_enabled_override_for_tests(Some(true));
        freshell_platform::clock::reset().expect("override enabled");
        Self { _guard: guard }
    }
}

impl Drop for GateGuard {
    fn drop(&mut self) {
        let _ = freshell_platform::clock::reset();
        freshell_platform::clock::set_enabled_override_for_tests(None);
    }
}

// Thin local wrappers: common/mod.rs has no raw text-frame send nor a bare
// create-frame builder (`create_shell_terminal` couples send with
// wait-for-created, which cannot express the expected-error sends below).
async fn send_text(ws: &mut common::TestWs, text: &str) {
    ws.send(WsMessage::Text(text.to_string()))
        .await
        .expect("send text frame");
}

/// Plain-JSON non-restore `terminal.create` frame (shell create; no CLI spec).
fn create_frame(request_id: &str) -> String {
    format!(
        r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system"}}"#
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn rate_limited_retry_same_requestid_proceeds() {
    let _gate = GateGuard::enable();
    let cfg = CreateProtectConfig {
        rate_limit: 1,
        rate_window_ms: 300,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _spawn_gate) =
        common::spawn_server_with_create_protect_probes(cfg).await;
    let (mut client, _inventory) = common::connect_and_capture_inventory(&ws_url).await;

    // Freeze BEFORE rl-1's send so rl-1's rate stamp and every check below
    // read the SAME frozen instant — deterministic under any scheduling load.
    freshell_platform::clock::freeze().unwrap();

    // First non-restore create consumes the whole 1-token budget.
    send_text(&mut client, &create_frame("rl-1")).await;
    let created = common::next_frame_of_type(&mut client, "terminal.created").await;
    assert_eq!(created["requestId"], "rl-1");

    // Second non-restore create is rate-limited (frozen clock: still the same
    // instant as rl-1's stamp — inside the 300ms window by construction).
    send_text(&mut client, &create_frame("rl-2")).await;
    let err = common::next_frame_of_type(&mut client, "error").await;
    assert_eq!(err["code"], "RATE_LIMITED");
    assert_eq!(err["requestId"], "rl-2");

    // Twice-limited sentinel-cleanup probe (unchanged from the original): the
    // immediate resend must ALSO be answered RATE_LIMITED — a leaked InFlight
    // sentinel would swallow the resend as a waiter (no error frame → the
    // bounded read fails), while a cleared sentinel re-enters an in-window
    // rate check (frozen clock: still the same instant).
    send_text(&mut client, &create_frame("rl-2")).await;
    let err2 = common::next_frame_of_type(&mut client, "error").await;
    assert_eq!(err2["code"], "RATE_LIMITED");
    assert_eq!(err2["requestId"], "rl-2");

    // Client-style retry: SAME requestId after the window slides — by VIRTUAL
    // advance only (400ms > 300ms window; zero wall-clock sleeps pace the
    // rate window).
    freshell_platform::clock::advance_ms(400).unwrap();
    send_text(&mut client, &create_frame("rl-2")).await;
    let retried = common::next_frame_of_type(&mut client, "terminal.created").await;
    assert_eq!(
        retried["requestId"], "rl-2",
        "same-requestId retry after RATE_LIMITED must proceed as a fresh create"
    );
    assert_eq!(registry.kill_all(), 2, "rl-1 plus the retried rl-2");
}
