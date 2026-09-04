//! Retire-on-kill round 6 (focused-ep5-r5 Finding 2) — the restart-boundary
//! integration pins. In-memory claude placeholder→durable alias tombstones
//! used to die with the server process, so the finding's exact interleaving
//! was: panes reconnect after a restart and resume their durable session
//! (slow); the user closes the pane before the resume re-registers the alias;
//! the close names only the bare placeholder and fences/retires nothing
//! durable; the resume then commits the durable row Bound and registers a
//! session for a pane that no longer exists — and the next recovery offers
//! it.
//!
//! The repair has two halves, pinned here across a REAL ledger reload (a
//! fresh `PaneLedger` over the same root + a fresh `FreshClaudeState` IS the
//! restart — every process-local map is empty, only the durable store
//! survives):
//!
//! 1. Alias tombstones are durable (the ledger's `alias-tombstones/`
//!    subtree, minted at registration/adoption and demoted at eviction), so a
//!    post-restart kill naming the bare placeholder still resolves, fences,
//!    and retires the durable row. (Test 1 — the finding's own order.)
//! 2. The claim commit consults the placeholder's fence: a close recorded
//!    under the one-shot seat blocks the commit exactly like one recorded
//!    under the durable id — the brief's literal pin: a restart boundary
//!    BETWEEN the fence write and the claim commit leaves the commit blocked
//!    and the row Retired. (Test 2.)
//!
//! Harness note: these tests drive `FreshClaudeState` DIRECTLY (no socket) —
//! the create/kill/attach handlers are public; the production
//! `spawn_sidecar()` is swapped by the SAME `FRESHELL_CLAUDE_SIDECAR` /
//! `FRESHELL_CLAUDE_NODE` env overrides `freshagent_claude_kill_interrupt.rs`
//! uses — so the alias-mint, kill, and attach lanes all run their real code
//! against a REAL on-disk ledger. `TestLedgerSink` mirrors
//! `freshell-server/src/identity_sink.rs`'s adapter (the ws test crate cannot
//! depend on freshell-server).

use std::sync::Arc;

use serde_json::Value;

use freshell_freshagent::{
    ClaimCommit, FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, RollbackRecord,
    SinkAliasClearWrite, SinkCommitWrite, SinkWrite,
};
use freshell_protocol::{
    AgentProvider, FreshAgentAttach, FreshAgentCreate, FreshAgentKill, SessionLocator, SessionType,
};
use freshell_ws::pane_ledger::{PaneLedger, RetiredReason, RowState};

/// Serializes every test in this file (process-global env vars mutate).
static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A minimal scripted fake claude sidecar (production wire protocol only):
/// `create` answers `created` with a fresh placeholder and then emits
/// `sdk.session.init` echoing `resumeSessionId` as the durable cli id (the
/// resume-continuity shape) so the ADOPTION path runs its real fold —
/// cli_index insert, binding write, and (round 6) the alias-tombstone mint
/// write. `shutdown` exits (the kill's graceful teardown drives it).
const FAKE_SIDECAR: &str = r#"
import fs from 'node:fs'
import readline from 'node:readline'

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
    const sessionId = `fake-claude-kar-${process.pid}-${counter}`
    process.stdout.write(JSON.stringify({ type: 'created', sessionId }) + '\n')
    const cliSessionId = msg.resumeSessionId || '00000000-0000-4000-8000-0000000000ff'
    console.log(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }))
    console.log(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }))
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// One test's temp root: the claude store (fake transcript), the fake
/// sidecar script, and the pane-ledger root (the durable store that survives
/// the scripted restart).
struct Rig {
    dir: tempfile::TempDir,
}
impl Rig {
    fn install(&self) {
        let script = self.dir.path().join("fake-sidecar.mjs");
        std::fs::write(&script, FAKE_SIDECAR).expect("write fake sidecar");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("CLAUDE_CONFIG_DIR", self.dir.path().join("claude-store"));
    }
    fn write_transcript(&self, durable: &str) {
        let dir = self
            .dir
            .path()
            .join("claude-store")
            .join("projects")
            .join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{durable}.jsonl")),
            r#"{"type":"user","cwd":"/tmp","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();
    }
    fn ledger_root(&self) -> std::path::PathBuf {
        self.dir.path().join("pane-ledger")
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
    }
}

/// The real-ledger identity-sink test double — mirrors
/// `freshell-server/src/identity_sink.rs`'s `LedgerIdentitySink`
/// (spawn_blocking awaited writes, inline memory reads), including the round-6
/// alias-tombstone lanes.
struct TestLedgerSink {
    ledger: Arc<PaneLedger>,
}
impl TestLedgerSink {
    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}
impl PaneIdentitySink for TestLedgerSink {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, m, c) = (
            placeholder_id.to_string(),
            mode.to_string(),
            cwd.map(str::to_string),
        );
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.record_pending(&p, &m, c.as_deref(), Default::default(), now)
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        let ledger = self.ledger.clone();
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let w = freshell_ws::pane_ledger::FreshAgentBindingWrite {
                    provider: &upsert.provider,
                    session_id: &upsert.session_id,
                    mode: &upsert.mode,
                    cwd: upsert.settings.cwd.as_deref(),
                    create_request_id: upsert.create_request_id.as_deref(),
                    model: upsert.settings.model.as_deref(),
                    sandbox: upsert.settings.sandbox.as_deref(),
                    permission_mode: upsert.settings.permission_mode.as_deref(),
                    effort: upsert.settings.effort.as_deref(),
                    supersedes: upsert.supersedes.as_deref(),
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                    now_ms: now,
                };
                ledger.record_fresh_agent_binding(&w)?;
                if let Some(p) = upsert.resolves_pending.as_deref() {
                    let _ = ledger.delete_pending(p);
                }
                Ok(())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        let row = self.ledger.load_binding(provider, session_id)?;
        (row.pane_kind.as_deref() == Some("fresh-agent")).then_some(FreshAgentSettings {
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
        })
    }
    fn was_recorded(&self, provider: &str, session_id: &str) -> bool {
        self.ledger.load_binding(provider, session_id).is_some()
    }
    fn load_provenance(&self, _: &str, _: &str) -> Option<freshell_freshagent::BindProvenance> {
        None
    }
    fn record_rollback(&self, p: &str, s: &str, record: RollbackRecord) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (p.to_string(), s.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let payload = serde_json::to_value(&record).map_err(std::io::Error::other)?;
                ledger.record_rollback_row(&p, &s, &payload, TestLedgerSink::now_ms())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn load_rollback(&self, provider: &str, session_id: &str) -> Option<RollbackRecord> {
        let payload = self.ledger.load_rollback_row(provider, session_id)?;
        RollbackRecord::from_stored_payload(payload)
    }
    fn delete_rollback(&self, p: &str, s: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (p.to_string(), s.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.delete_rollback_row(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn lookup_by_create_request_id(&self, _: &str, _: &str) -> Option<String> {
        None
    }
    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.retire_closed_compensated(&p, &s, TestLedgerSink::now_ms())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn delete_pending(&self, placeholder_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let p = placeholder_id.to_string();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.delete_pending(&p))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.clear_kill_tombstone(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn kill_tombstone_at_ms(&self, provider: &str, session_id: &str) -> Option<i64> {
        self.ledger.kill_tombstone_at(provider, session_id)
    }
    fn row_is_bound(&self, provider: &str, session_id: &str) -> bool {
        self.ledger.row_is_bound(provider, session_id)
    }
    fn commit_claim(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
    ) -> SinkCommitWrite {
        self.commit_claim_aliased(provider, session_id, expect_killed_at_ms, &[])
    }
    fn commit_claim_aliased(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
        fence_checked_aliases: &[String],
    ) -> SinkCommitWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let aliases: Vec<String> = fence_checked_aliases.to_vec();
        Box::pin(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                ledger.commit_claim_aliased(
                    &p,
                    &s,
                    expect_killed_at_ms,
                    &aliases,
                    TestLedgerSink::now_ms(),
                )
            })
            .await
            .map_err(std::io::Error::other)??;
            Ok(match outcome {
                freshell_ws::pane_ledger::ClaimCommitOutcome::Committed => ClaimCommit::Committed,
                freshell_ws::pane_ledger::ClaimCommitOutcome::RefusedStale => {
                    ClaimCommit::RefusedStale
                }
            })
        })
    }
    fn record_alias_tombstone(
        &self,
        provider: &str,
        placeholder: &str,
        durable: &str,
        at_ms: i64,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, ph, d) = (
            provider.to_string(),
            placeholder.to_string(),
            durable.to_string(),
        );
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.record_alias_tombstone(&p, &ph, &d, at_ms))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn alias_tombstone_records(&self, provider: &str, placeholder: &str) -> Vec<(String, i64)> {
        self.ledger.alias_tombstone_records(provider, placeholder)
    }
    fn clear_alias_tombstones_for_durable(
        &self,
        provider: &str,
        durable: &str,
    ) -> SinkAliasClearWrite {
        let ledger = self.ledger.clone();
        let (p, d) = (provider.to_string(), durable.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.clear_alias_tombstones_for_durable(&p, &d))
                .await
                .map_err(std::io::Error::other)?
        })
    }
}

/// One process generation: a fresh `FreshClaudeState` over a REAL ledger
/// rooted at `root` (a second generation over the same root IS the restart).
fn new_generation(
    root: &std::path::Path,
) -> (
    freshell_freshagent::FreshClaudeState,
    Arc<PaneLedger>,
    tokio::sync::broadcast::Receiver<String>,
) {
    let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
    let st = freshell_freshagent::FreshClaudeState::new(Arc::new(tx));
    let ledger = Arc::new(PaneLedger::new(Some(root.to_path_buf())));
    st.set_identity_sink(Arc::new(TestLedgerSink {
        ledger: ledger.clone(),
    }));
    (st, ledger, rx)
}

fn create_msg_resume(request_id: &str, durable: &str) -> FreshAgentCreate {
    FreshAgentCreate {
        request_id: request_id.to_string(),
        session_type: SessionType::Freshclaude,
        provider: Some(AgentProvider::Claude),
        cwd: Some("/t".to_string()), // settings-bearing: the adoption writes the row
        legacy_restore_context: None,
        resume_session_id: None,
        session_ref: Some(SessionLocator {
            provider: "claude".to_string(),
            session_id: durable.to_string(),
        }),
        model: None,
        model_selection: None,
        permission_mode: None,
        sandbox: None,
        effort: None,
        plugins: None,
        tab_id: None,
    }
}

fn attach_msg(seat: &str, durable: &str) -> FreshAgentAttach {
    FreshAgentAttach {
        provider: AgentProvider::Claude,
        session_id: seat.to_string(),
        session_type: SessionType::Freshclaude,
        cwd: None,
        resume_session_id: None,
        session_ref: Some(SessionLocator {
            provider: "claude".to_string(),
            session_id: durable.to_string(),
        }),
    }
}

fn kill_msg(session_id: &str) -> FreshAgentKill {
    FreshAgentKill {
        provider: AgentProvider::Claude,
        session_id: session_id.to_string(),
        session_type: SessionType::Freshclaude,
        cwd: None,
    }
}

/// Bounded drain of the broadcast receiver until a frame containing `needle`
/// arrives (the lane answers always broadcast through this bus).
async fn await_frame_containing(
    rx: &mut tokio::sync::broadcast::Receiver<String>,
    needle: &str,
) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let raw = rx.recv().await.expect("bus frame");
            if raw.contains(needle) {
                return serde_json::from_str(&raw).expect("frame is JSON");
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("a frame containing {needle} within budget"))
}

/// Bounded wait for a condition (the consumer's adoption fold runs on its
/// own task; the deadline poll is the suite convention).
async fn await_condition(what: &str, cond: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if cond() {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{what} (never happened)"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// Test 1 — the finding's own order across the restart: create-with-resume
/// in generation 1 (the row lands Bound, the alias mapping is persisted at
/// registration/adoption); "restart" (generation 2 over the same durable
/// root — every process-local map is empty); the user THEN closes the pane
/// by its bare placeholder. The kill must resolve the PERSISTED alias, so
/// the durable row ends Retired(Closed) with its fence standing. And the
/// reconnect's late attach (riding the closed seat) must be refused —
/// nothing registers, the row never revives.
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_naming_the_bare_placeholder_after_a_restart_retires_the_durable_row_and_blocks_the_late_attach() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let rig = Rig { dir: tempfile::tempdir().expect("temp dir") };
    rig.install();
    let durable = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1".to_string();
    rig.write_transcript(&durable);
    let root = rig.ledger_root();

    // Generation 1: the session lives; the durable alias record is minted.
    let placeholder = {
        let (st1, ledger1, mut rx1) = new_generation(&root);
        st1.handle_create(create_msg_resume("req-kar-1", &durable), None)
            .await;
        let created = await_frame_containing(&mut rx1, "\"freshAgent.created\"").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let ledger1b = ledger1.clone();
        let dur = durable.clone();
        let ph = placeholder.clone();
        await_condition("the adoption row + alias record", move || {
            ledger1b
                .load_binding("claude", &dur)
                .is_some_and(|r| r.state == RowState::Bound)
                && !ledger1b.alias_tombstone_records("claude", &ph).is_empty()
        })
        .await;
        placeholder
        // generation 1 drops here — the "restart"
    };

    // Generation 2: no process-local mapping anywhere.
    let (st2, ledger2, mut rx2) = new_generation(&root);
    assert!(
        ledger2
            .alias_tombstone_records("claude", &placeholder)
            .iter()
            .any(|(d, _)| d == &durable),
        "the persisted alias record survived the scripted restart"
    );

    // The user closes the pane by its bare placeholder NOW (the finding's
    // window — before any resume re-registers the alias in memory).
    st2.handle_kill(kill_msg(&placeholder)).await;

    let row = ledger2
        .load_binding("claude", &durable)
        .expect("the durable row");
    assert_eq!(row.state, RowState::Retired, "the close retired the durable row");
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    assert!(
        ledger2.kill_tombstone_at("claude", &durable).is_some(),
        "the durable close fence landed"
    );
    assert!(
        ledger2.kill_tombstone_at("claude", &placeholder).is_some(),
        "the placeholder's own fence landed too"
    );

    // The reconnect's late attach (riding the closed seat) must be refused:
    // no session registers, the row never revives.
    st2.handle_attach(attach_msg(&placeholder, &durable)).await;
    let failed = await_frame_containing(&mut rx2, "CLAUDE_ATTACH_RESUME_FAILED").await;
    assert_eq!(failed["type"], "error");
    let row = ledger2
        .load_binding("claude", &durable)
        .expect("the durable row");
    assert_eq!(
        row.state,
        RowState::Retired,
        "the row stays Retired — the phantom claim never revived it"
    );
    assert!(
        ledger2.kill_tombstone_at("claude", &durable).is_some(),
        "the fence still stands"
    );
    assert!(
        !st2.has_live_session(&durable).await,
        "nothing live registered for the closed pane"
    );
}

/// Test 2 — the brief's literal pin: the restart boundary sits BETWEEN the
/// fence write and the claim commit. Generation 1 closes the pane (the kill
/// fences placeholder AND durable and retires the row — the live generation
/// resolves its own aliases); the restart then wipes every process-local
/// alias; the late attach's commit must be blocked (a fence recorded under
/// the one-shot seat blocks exactly like one under the durable), and the row
/// stays Retired.
#[tokio::test(flavor = "multi_thread")]
async fn a_close_fenced_before_the_restart_blocks_the_late_claim_and_the_row_stays_retired() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let rig = Rig { dir: tempfile::tempdir().expect("temp dir") };
    rig.install();
    let durable = "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2".to_string();
    rig.write_transcript(&durable);
    let root = rig.ledger_root();

    // Generation 1: create-with-resume lives, then the close lands.
    let placeholder = {
        let (st1, ledger1, mut rx1) = new_generation(&root);
        st1.handle_create(create_msg_resume("req-kar-2", &durable), None)
            .await;
        let created = await_frame_containing(&mut rx1, "\"freshAgent.created\"").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let ledger1b = ledger1.clone();
        let dur = durable.clone();
        let ph = placeholder.clone();
        await_condition("the adoption row + alias record", move || {
            ledger1b
                .load_binding("claude", &dur)
                .is_some_and(|r| r.state == RowState::Bound)
                && !ledger1b.alias_tombstone_records("claude", &ph).is_empty()
        })
        .await;

        // THE FENCE WRITE (pre-restart): the user closes the pane.
        st1.handle_kill(kill_msg(&placeholder)).await;
        let row = ledger1
            .load_binding("claude", &durable)
            .expect("the durable row");
        assert_eq!(row.state, RowState::Retired, "pre-restart: the close retired the row");
        assert!(ledger1.kill_tombstone_at("claude", &durable).is_some());
        placeholder
    };

    // ── the restart boundary: every in-memory alias/fence-holder is gone ──
    let (st2, ledger2, mut rx2) = new_generation(&root);
    assert!(
        ledger2.kill_tombstone_at("claude", &placeholder).is_some(),
        "the seat's fence is durable across the restart"
    );

    // The claim commit lands now — it must be BLOCKED, the row stays Retired.
    st2.handle_attach(attach_msg(&placeholder, &durable)).await;
    let failed = await_frame_containing(&mut rx2, "CLAUDE_ATTACH_RESUME_FAILED").await;
    assert_eq!(failed["type"], "error");
    let row = ledger2
        .load_binding("claude", &durable)
        .expect("the durable row");
    assert_eq!(
        row.state,
        RowState::Retired,
        "the row stays Retired across the restart boundary"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    assert!(
        ledger2.kill_tombstone_at("claude", &durable).is_some(),
        "the durable fence is never cleared by the blocked commit"
    );
    assert!(
        !st2.has_live_session(&durable).await,
        "nothing live registered for the closed pane"
    );
}
