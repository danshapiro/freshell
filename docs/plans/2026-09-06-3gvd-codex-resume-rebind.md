# Codex In-TUI Thread-Switch Tracking Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result

A Codex terminal pane in Freshell must continuously track the canonical durable Codex thread it displays, including thread changes that occur after launch through the in-TUI `/resume` flow, the interactive resume picker, or equivalent in-TUI navigation — it must not infer identity only from startup argv or a short startup locator window. When the active durable thread changes: update the terminal's and pane's canonical `sessionRef` atomically; persist the new binding to the pane ledger and the tabs-sync snapshot; update the left sidebar so the correct session shows as running in exactly that pane; remove stale running/attachment attribution from the startup or previously selected thread; ensure tab titles, grey/running state, deduplication, and session selection use the new identity; ensure idle reap, browser reconnect, and server restart resume the newly selected durable thread rather than spawning an empty one; and keep capture/preflight continuity tooling reporting the pane as identity-covered, with unresolved coding panes remaining an explicit hard failure.

### Explicit constraints

- Observe Codex's authoritative app-server/thread lifecycle signal for the lifetime of the PTY; handle thread start/resume/switch events that occur after the initial locator deadline.
- Never scrape rendered terminal output and never depend on process argv changing (argv stays plain `codex` across an in-TUI resume).
- Ship the five acceptance behaviors as executable tests: (a) integration — locator window expired, then a simulated in-TUI/app-server switch converges terminal, pane, ledger, and tabs snapshot on the durable thread; (b) client — sidebar running/attached moves old→new without duplicates or grey errors; (c) restart — a server restart after the persisted switch resumes the exact durable thread in the same logical pane; (d) repeat-switch — A→B supersedes A everywhere; (e) failure — no authoritative identity ⇒ continuity capture/preflight fails closed.
- Preserve the identity-lane contracts this work builds on: D-03 first-bind-wins for non-resume candidate sources, the disk fork-watch lane's ownership of fork rebinds (D-FORK), the D7/A13/A8/freshagent guards, and the S5.c identity gate that holds only `turn/start` + `thread/fork`.

### Accepted tradeoffs and residuals

- The fix targets the Rust server and web client only. The Node server (not the day-to-day production path per repo docs) receives no parallel change, and no repo test forces parity.
- A thread switch made while the Freshell server is down is outside this change's detection lifetime; the pane-ledger supersession chain plus the deploy-tab-diff `RE-POINTED`/`NO CAPTURED IDENTITY` verdicts remain the detection net, and a `~/.codex/logs_2.sqlite` corroborating tail is explicitly deferred (Notes for later jobs).
- The unmanaged launch lane (`FRESHELL_CODEX_MANAGED_LAUNCH=0`) has no remote proxy and stays startup-locator-scoped for resume detection.
- User-set tab titles never migrate across a rebind; an automatic tab title adopts the resumed session's session-directory title only when the client already knows one.

**Goal:** A Codex pane that switches threads inside its TUI keeps an accurate canonical identity everywhere Freshell persists or displays it — sidebar, ledger, tabs snapshots, recovery — across idle reap, browser reconnect, and server restart.

**Architecture:** Freshell already sits on the wire that carries the switch: the per-pane `CodexRemoteProxy` relays every JSON-RPC frame between the Codex TUI and its app-server sidecar. This change (1) teaches the proxy to extract `thread/resume` responses into a new `ThreadResumeResponse` candidate (request-correlated: the response's `result.thread` is the thread the TUI switched TO, and resume preserves the caller-requested id), and (2) routes that candidate source in the WS router: unbound pane → existing adoption tail; resume of the currently bound thread → no-op; resume of a DIFFERENT thread → the existing `rebind_codex_identity` single-writer tail (identity store, registry meta, fsynced pane-ledger supersession, `terminal.session.associated` with `previousSessionId`, `terminal.meta.updated`, activity-hub re-key + rollout re-attach) plus the two fan-out additions a rebind needs (sidecar reattach key, fork-watch re-registration). The client's `previousSessionId`-authorized fold already moves pane/tab/tabs-sync identity atomically; this plan additionally closes its two leftovers (stale `isRunning` on the superseded session row; automatic tab titles) and pins the continuity tooling's fail-closed verdicts for codex panes.

**Tech Stack:** Rust workspace crates `freshell-codex` (remote proxy) and `freshell-ws` (identity, router, association), tokio; TypeScript/React/Redux Toolkit client (`sessionsSlice`, `terminal-session-association`, `sidebarSelectors`); Vitest unit suites, cargo test integration suites (with `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`), Playwright e2e (`rust-chromium`).

## Global Constraints

- Red/green/refactor per task: one meaningful failing test first, run it and confirm it fails for the intended missing behavior, then the smallest implementation, then refactor while green. One task = one conventional commit.
- Focused runs use repo entrypoints exactly as written: `npm run test:vitest -- run <path> [-t "<name>"]` (never raw `npx vitest`; the coordinator passthrough infers config by path — `test/unit/server/**` selects the server config, client paths the default config); cargo invocations exactly as written per task. Broad/cross-config runs honor the shared coordinator gate (`npm run test:status`; wait, never kill a foreign holder). e2e runs locally via `scripts/e2e-cloud.sh run --local --project=rust-chromium <spec>` (forcing `--local` per-invocation does not change anyone's configured backend).
- The baseline ledger names three pre-existing failures (`test/unit/vite-config.test.ts > getNetworkHost > …` ×3, evidence log `20260826T072730.269457282Z.qa.log`). Do not repair them to force a green run; the full gate is accepted with exit 1 only when every parsed failure identity is in that set.
- Never restart, kill, or signal the production Freshell server (port 3001) or any foreign process; every test harness binds its own ephemeral loopback port (never 3001/3002); process-global env mutated in tests (`CODEX_HOME`, `CODEX_CMD`, `FAKE_CODEX_APP_SERVER_BEHAVIOR`, `CODEX_ARGV_CAPTURE_PATH`) is restored per test and serialized with the owning file's lock.
- Never scrape terminal output for identity, never depend on argv changing, never consume a `thread/started` notification as resume evidence (the fixture broadcasts one after `thread/resume`; the real app-server's retained logs show `COUNT=0` — do not lean on it), and never read `~/.codex/*.sqlite` from production code in this change (deferred residual above).
- Preserve: D-03 first-bind-wins for non-resume sources; D-FORK disk-lane ownership of fork rebinds; the existing identity guards (D7 live-owner, A13 no-live-owner-of-new, A8 retired-inclusive claim, freshagent lane); the S5.c gate's hold set (`turn/start`, `thread/fork` only — `thread/resume` must keep flowing or no pane could ever move).
- Server-side TypeScript under `server/` is untouched by this plan; if any future edit touches it, NodeNext/ESM `.js` relative-import suffixes are mandatory. `cargo fmt --all --check` and the repo's clippy lines must be green at every task commit.
- Conventional commits; `docs/index.html` untouched (continuity fix, no user-visible mock change); `.kata.toml` untouched; the Node server untouched; `scripts/deploy-tab-diff.sh` untouched (its verdicts already cover codex — only tests are added).

## Design orientation (verified evidence map)

Stage-1 explorers verified every anchor below against the live worktree and a live codex 0.149.x install. Full reports: `<logs_dir>/reports/plan-codex-on-disk-signals.md`, `plan-sidebar-identity.md`, `plan-restart-recovery.md`, `plan-traits-tests.md`.

**Topology.** Each managed Codex pane owns two processes: a spawned `codex app-server --listen ws://…` sidecar and the TUI (`codex --remote ws://<proxy>`). The proxy (`crates/freshell-codex/src/remote_proxy.rs`) is a freshell-owned relay between them: every frame in both directions passes through it. `extract_thread_start_response_candidate` / `extract_fork_response_candidate` / the `thread/started` notification arm already exist (`crates/freshell-codex/src/remote_proxy_side_effects.rs`); the upstream-response dispatcher (`remote_proxy.rs:1236-1262`) special-cases exactly `thread/start` (:1249) and `thread/fork` (:1253) — **everything else, including `thread/resume`, relays verbatim with no side-effect scan**. That is the extraction gap.

**What changes on disk across an in-TUI switch (observed against the live install).** A mid-life thread switch lands in `~/.codex/logs_2.sqlite` as `app-server request: thread/resume` plus the OTel span rows, process-scoped by `process_uuid = pid:<sidecar-pid>:<uuid>`; the resumed thread id appears in span-descendant rows' `thread_id` column. Argv never changes (live plain-launch TUIs prove it). Resume-to-existing appends to the EXISTING rollout file — no new file — so the disk snapshot-diff locator lane structurally cannot see it. Conclusion: the wire (proxy `thread/resume` request + response) is the authoritative, per-pane, zero-latency signal; the sqlite log is its durable shadow and stays a deferred residual.

**The writer tail is ready.** `crates/freshell-ws/src/codex_identity.rs`:
- `adopt_codex_identity(state, CodexAdoption { terminal_id, thread_id, rollout_path: Option<&Path>, cwd })` (:60) → `apply_codex_identity` (:186-227).
- `rebind_codex_identity(state, CodexRebind { terminal_id, old_session_id, new_session_id, rollout_path: &Path, cwd })` (:81-123) — guards: pane must be the LIVE owner of old (D7 via `registry.live_session_owner`, identity arm requires a Running row — `freshell-terminal/src/registry.rs:2538-2559`), new must have no live owner (A13), `codex_claim_refused` retired-inclusive + freshagent lane (A8); then the same tail with `Some(old_session_id)`.
- `apply_codex_identity` order: identity-store upsert → registry `set_meta` → `ledger_resolve_identity` AWAITED (fsync-before-announce; new bound row first, old retired `Superseded` with `supersededBy`) → `terminal.session.associated` then `terminal.meta.updated` (order pinned :234-237; `previousSessionId` included when rebind, omitted via `skip_serializing_if` on adopt) → activity hub `bind_codex_session` + `attach_codex_rollout` (the latter REPLACES the RolloutTailer lane, `activity.rs:739-742`).

**The router today.** `crates/freshell-ws/src/codex_proxy_route.rs::route_candidate` (:116-211): D-FORK ignore (:122-126) → ephemeral skip (:128-134) → empty-id/relative-path skip (:136-147, legacy bind predicate) → D-03 first-bind-wins on a DIFFERENT incoming id (:148-160) → adoption tail (`adopt_codex_identity` + `mark_candidate_persisted` + `note_session_id` + spawn_blocking `watch_fork`, :161-205; `fail_candidate_capture` on refusal :206-210). D-03 exists to pin first-bind; it also swallows every later candidate including a genuine in-TUI resume — this is the routing bug the kata needs lifted for exactly one source.

**Fan-out gaps a resume arm must close** (verified against current code):
1. Sidecar store record `session_id` is reattach-keyed (`claim_for_session`) but only the ADOPT tail calls `CodexTerminalLaunchManager::note_session_id` (router :181-186 → `launch_lifecycle.rs:892-901`). The disk fork lane (`codex_association.rs:220-254`) never calls it; a future `thread/resume` arm must, and the disk lane gets the same fix (Task 3).
2. Fork watch: the disk lane's `tick_forks` auto-advances the watch only for disk-detected forks (`codex_locator.rs:557-559` region); a proxy-driven resume rebind must explicitly `watch_fork(terminal, NEW)` like the adopt arm (:191-205).
3. `mark_candidate_persisted` is only meaningful pre-first-bind; rebind needs nothing there.

**Candidate-capture gate timeline (validated Stage 2, LB4).** A fresh managed pane arms two timers: 45s candidate-capture from PROXY start and a 5s hold timer armed by the FIRST held frame. The hold set is exactly `turn/start` + `thread/fork` — `thread/resume` is never held, in Holding OR Failed state. On capture-timeout (or explicit capture failure) the proxy answers held frames with -32000, emits the log-only RepairTrigger, and closes every relay socket pair (the pane PTY itself is untouched). After that the gate is Failed: a NEW TUI connection gets a fresh upstream dial, and non-gated methods — including `thread/resume` — flow normally, so the kata's late resume keeps producing candidates even past the window. Consequence for the tests below: every integration/e2e leg must complete well inside the 45s window from pane spawn (they do — seconds, not tens of seconds), and no test may assert relay-state semantics across a capture timeout.

**Client fold is complete; two seams remain.** `terminal.session.associated` with `previousSessionId` routes through `reconcileTerminalSessionAssociation` (`src/lib/terminal-session-association.ts:62-156`) → `panesSlice.reconcileTerminalSessionRefByTerminalId` + `tabsSlice.updateTab` (+ `sessionMetadataByKey` re-key via `mergeSessionMetadataForPreferredResumeId`, `persistControl.ts:13-88`) → `flushPersistedLayoutNow()` (:152-154) — the next `tabs.sync.push` then carries the new sessionRef, and its payload passes the server's provider-matches-mode validation (`tabs_persist_validation.rs:248-275`). Everything the sidebar shows (running, hasTab, busy, active, rings, dedupe, grey) derives from pane content + terminalDirectory items in the same render pass. Seams: (a) `patchProjectRunningState` (`sessionsSlice.ts:278-320`) sets `isRunning` on the NEW row but never clears the OLD row on an identity-move upsert (clears only on `remove` or provider-less upserts) until the 50ms-debounced session-window refresh replaces rows server-side; (b) the fold deliberately never touches tab titles, so a non-user-set tab keeps the superseded thread's title.

**Recovery requires no new machinery.** Idle reap (`registry.rs:917-978`), browser reconnect, and server restart all funnel into the same client `Respawn` path: `terminal.create{restore:true, sessionRef}` → `derive_launch_prep` (`terminal.rs:1921-2006`) derives the resume id from `sessionRef.sessionId` when provider==mode → `gate_wire_resume` disk gate → `LaunchClass::Restore` → argv `codex resume <id>` via the manifest's `resumeArgs: ["resume","{{sessionId}}"]` (`cli_launch.rs:476-489`). No `sessionRef` ⇒ plain `codex` (the incident). Once the rebind lands (ledger + client fold + tabs.sync persist), all three converge on the NEW thread with zero recovery-path changes. The pane-reconcile rung 2b (`reconcile.rs:135-153`) already follows the ledger `supersededBy` chain to the terminus, so even a stale pre-restart claim corrects to the new thread.

**Fail-closed continuity already exists.** `scripts/deploy-tab-diff.sh`: capture's coverage gate (`uncovered_terminals` :150-167, exit 4 at :256-272; enriched `session=none` listing via `report_uncovered` :169-200); verify's identity diff (`NO CAPTURED IDENTITY` :340-342 — session-capable modes hardcoded `["claude","codex","opencode","amplifier"]`; `FRESH (identity lost)` :344; `RE-POINTED` :348; `NOT RESPAWNED` :351; non-empty ⇒ exit 1 :353+). Pinned by `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` (offline harness: `captureDoc`/`term`/`openRecord`/`pane` fixtures + `makeAbortCurl` so zero network calls).

**Fixture reality checks.** `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`: `thread/resume` at :288-306 — `threadId = behavior.threadResumeThreadId || params?.threadId || 'thread-new-1'` (echoes the request's id by default ⇒ request/response agreement holds in tests), `threadResumeRolloutPath`/`threadResumeEphemeral` knobs, `makeThread` (`:215-232`) yields `{id, path, ephemeral:false, …}` matching `extract_result_thread` exactly; durable rollout writes gated by `FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES=1` (:646-658). The fake also broadcasts `thread/started` after resume (:769-775) — never relied on (above), but tests must tolerate its presence. The fixture-driven dispatchers: `codex_sidecar_reattach_e2e.rs` owns `CODEX_CMD` dispatcher shim (:228-255; app-server argv → fixture, else dump TUI argv JSON to `$CODEX_ARGV_CAPTURE_PATH`), per-instance behavior env via `Command.env` (:455-458), `tui_resume_via_proxy` (:503-540: dial the pane's `--remote` URL, `initialize`/`initialized`, then `thread/resume`), `resume_pair_position` (:427), `test_lock()` serialization (:115), one never-dropped runtime `reattach_rt` (:103).

**e2e conventions.** `test/e2e-browser/specs/opencode-rebind-rust.spec.ts` is THE rebind spec pattern (WsCapture `waitFor` sequence asserts :307-331, Redux fold asserts :360+, respawn/never-steal legs :469-526). `test/e2e-browser/fixtures/codex-dual-role.ts` installs the dual-role codex shim (app-server argv → committed fixture; else terminal fake). Registration is two-list explicit: `RUST_ONLY_SPECS` (playwright.config.ts:238 region) AND the `rust-chromium` `testMatch` (:493 has `opencode-rebind-rust`). A new spec stays cloud-legal via fully self-installed fakes (not `CLOUD_SKIP_SPECS`).

## Requirement → verification map

| Work-item requirement | Production change | Proved by |
| --- | --- | --- |
| Continuous tracking post-locator-deadline, no argv/scraping | Task 1 proxy extraction; Task 2 router arm | T1 unit+relay tests; Task 2 integration test fn1/fn2, Playwright e2e |
| Atomic terminal/pane `sessionRef` update | Task 2 arm → `rebind_codex_identity` tail (frames in pinned order, ledger fsync-before-announce) | Router unit pins (frames order/content); integration fn1/fn2 |
| Persist binding to pane ledger + tabs-sync snapshot | tail's `ledger_resolve_identity` supersession; existing client fold + `flushPersistedLayoutNow()` → next `tabs.sync.push` | integration fn1 (ledger rows; pushed snapshot persisted server-side); fn2 (supersession rows) |
| Sidebar: correct session running in exactly that pane; stale attribution removed; no dup/grey errors | Task 4 reducer fix + selector pin; e2e DOM asserts | T4 unit tests; Playwright legs |
| Tab titles/grey/dedupe/selection follow new identity | Task 5 title adoption (non-user-set); dedupe/selection ride the existing derived selectors | T5 unit tests (+T4 selector case) |
| Idle reap / browser reconnect / server restart resume the NEW thread | no new code — `sessionRef → codex resume <id>` already; tests pin it against the NEW id | integration fn2 phase-4; Playwright restart leg |
| Capture/preflight reports identity-covered; unresolved = explicit hard failure | none (existing gates); pins added | Task 6 pin tests |
| Repeat switch A→B supersedes A everywhere | Task 2 arm (rebind-of-rebind) | integration fn2; router unit pins |

---

### Task 1: Extract `thread/resume` response candidates in the Codex remote proxy

**Files:**
- Modify: `crates/freshell-codex/src/remote_proxy_side_effects.rs` (CandidateSource at :71-76; SideEffectError at :32-47; options struct after `ForkResponseOptions` :134-137; new extractor after `extract_fork_response_candidate` :434)
- Modify: `crates/freshell-codex/src/remote_proxy.rs` (ConnState at :627-642; request dispatch arm directly after the fork arm :1072-1075; response dispatch arm :1249-1262; two new handlers; module doc list at :9-11)
- Test: `crates/freshell-codex/src/remote_proxy_side_effects.rs` in-module `#[cfg(test)]` tests (:780+; reuse builders `create_thread` :799, `create_operation_result` :805, `ROLLOUT_PATH` :828)
- Test: `crates/freshell-codex/tests/remote_proxy_relay.rs` (`#![cfg(feature = "real-transport")]`; new fn beside `thread_start_response_is_relayed_unchanged_and_yields_a_candidate_event` :306; helpers `start_fake_upstream` :47, `connect_tui` :128, `recv_text` :138, `recv_events` :151, `RECV_TIMEOUT`)

**Interfaces:**
- Consumes: `scan_root_object` (:144), `has_any_duplicate_key`, `extract_top_level_id` (:266, returns `crate::protocol::RequestId` = `#[derive(Clone, Debug, PartialEq, Eq, Hash)] enum { Int(i64), Str(String) }` at protocol.rs:33-37), `extract_result_thread` (:335-350 — shape-proven against the fixture's resume reply), `SideEffectError`, `envelope_id_to_request_id`, `extract_thread_fork_parent_thread_id` (:1792 — the bounded `params.threadId` byte-scanner used by fork; reused verbatim for resume requests), `ConnState.pending_methods`/`pending_fork_requests` maps (:627-642 — `forward_client_frame` already records every request's method at :1096-1105).
- Produces:
  - `CandidateSource::ThreadResumeResponse` (new enum variant)
  - `SideEffectError::IdNotPendingThreadResume`, `SideEffectError::ResumeIdMismatch` (new variants; keep the enum's alphabetical ordering — insert after `IdNotPendingFork` / `RelativeRolloutPath` respectively)
  - `ThreadResumeResponseOptions<'a> { requested_thread_id: Option<&'a str>, enforce_id_agreement: bool, pending_thread_resume_request_ids: &'a std::collections::HashSet<crate::protocol::RequestId> }` — `enforce_id_agreement` is true ONLY for threadId-mode resumes: LB1 (validated against the protocol crate pinned to the installed codex 0.153.4) says `params.threadId` is IGNORED when experimental `params.history` or non-empty `params.path` are supplied ("history > non-empty path > thread_id"), so those modes must not hard-fail a mismatch. Wire reality also confirmed there: `result.thread.path` is nullable and null ⇔ `ephemeral: true`; an ephemeral resume candidate is emitted and the ROUTER's existing predicate drops it downstream (correct — nothing durable to bind).
  - `extract_thread_resume_response_candidate(raw: &[u8], options: &ThreadResumeResponseOptions<'_>) -> SideEffectResult<RemoteProxyCandidate>`
  - On the wire: exactly one `RemoteProxyEvent::Candidate` with that source per valid `thread/resume` response, on the existing sink consumed by the WS router (`crates/freshell-ws/src/codex_proxy_route.rs::route_proxy_event` :47/:55-56).

- [ ] **Step 1: Write the failing behavioral test**

Add these in-module tests (style mirrors the existing thread/start cases at :983-1008; `json!`, `HashSet`, and `RequestId` imports already exist in the test module):

```rust
#[test]
fn extracts_a_thread_resume_response_candidate_with_requested_id() {
    let raw = json!({
        "id": 21,
        "result": create_operation_result(create_thread(
            "thread-B",
            json!({ "path": ROLLOUT_PATH, "ephemeral": false }),
        )),
    })
    .to_string();
    let mut pending = HashSet::new();
    pending.insert(RequestId::Int(21));

    let extracted = extract_thread_resume_response_candidate(
        raw.as_bytes(),
        &ThreadResumeResponseOptions {
            requested_thread_id: Some("thread-B"),
            enforce_id_agreement: true,
            pending_thread_resume_request_ids: &pending,
        },
    )
    .expect("expected a resume candidate");

    assert_eq!(extracted.source, CandidateSource::ThreadResumeResponse);
    assert_eq!(extracted.thread.id, "thread-B");
    assert_eq!(extracted.thread.path.as_deref(), Some(ROLLOUT_PATH));
    assert!(!extracted.thread.ephemeral);
}

#[test]
fn rejects_a_resume_candidate_whose_response_id_was_never_requested() {
    let raw = json!({
        "id": 21,
        "result": create_operation_result(create_thread("thread-B", json!({ "path": ROLLOUT_PATH }))),
    })
    .to_string();
    let pending = HashSet::new();
    let err = extract_thread_resume_response_candidate(
        raw.as_bytes(),
        &ThreadResumeResponseOptions {
            requested_thread_id: Some("thread-B"),
            enforce_id_agreement: true,
            pending_thread_resume_request_ids: &pending,
        },
    )
    .expect_err("responses for never-requested ids must not yield candidates");
    assert_eq!(err, SideEffectError::IdNotPendingThreadResume);
}

#[test]
fn rejects_a_resume_candidate_that_disagrees_with_the_requested_thread() {
    // The request resumed thread-A; a response naming thread-B is a decoy or a
    // protocol bug — fail closed, never an identity candidate.
    let raw = json!({
        "id": 21,
        "result": create_operation_result(create_thread("thread-B", json!({ "path": ROLLOUT_PATH }))),
    })
    .to_string();
    let mut pending = HashSet::new();
    pending.insert(RequestId::Int(21));
    let err = extract_thread_resume_response_candidate(
        raw.as_bytes(),
        &ThreadResumeResponseOptions {
            requested_thread_id: Some("thread-A"),
            enforce_id_agreement: true,
            pending_thread_resume_request_ids: &pending,
        },
    )
    .expect_err("request/response thread disagreement must fail closed");
    assert_eq!(err, SideEffectError::ResumeIdMismatch);
}

#[test]
fn extracts_a_resume_candidate_when_the_request_carried_no_thread_id() {
    // `thread/resume` without params.threadId resumes "latest" — nothing to agree with.
    let raw = json!({
        "id": 21,
        "result": create_operation_result(create_thread("thread-B", json!({ "path": ROLLOUT_PATH }))),
    })
    .to_string();
    let mut pending = HashSet::new();
    pending.insert(RequestId::Int(21));
    let extracted = extract_thread_resume_response_candidate(
        raw.as_bytes(),
        &ThreadResumeResponseOptions {
            requested_thread_id: None,
            enforce_id_agreement: false,
            pending_thread_resume_request_ids: &pending,
        },
    )
    .expect("no attribution to check against");
    assert_eq!(extracted.thread.id, "thread-B");
}

#[test]
fn relaxes_id_agreement_for_history_or_path_mode_resumes() {
    // Protocol reality (validated Stage 2, LB1): when params.history or a
    // non-empty params.path were supplied, the server IGNORES params.threadId —
    // a response id differing from the recorded request id is then LEGAL and
    // must produce a candidate, not ResumeIdMismatch.
    let raw = json!({
        "id": 21,
        "result": create_operation_result(create_thread("thread-Z", json!({ "path": ROLLOUT_PATH }))),
    })
    .to_string();
    let mut pending = HashSet::new();
    pending.insert(RequestId::Int(21));
    let extracted = extract_thread_resume_response_candidate(
        raw.as_bytes(),
        &ThreadResumeResponseOptions {
            requested_thread_id: Some("thread-A"),
            enforce_id_agreement: false,
            pending_thread_resume_request_ids: &pending,
        },
    )
    .expect("history/path-mode resume must not hard-fail on id mismatch");
    assert_eq!(extracted.thread.id, "thread-Z");
}

#[test]
fn emits_an_ephemeral_resume_candidate_with_a_null_path_for_downstream_predicates() {
    // thread.path is nullable on the wire (null iff ephemeral). The extractor
    // mirrors the wire faithfully; the ROUTER's bind predicate drops ephemeral /
    // path-less candidates — do not fuse that decision into the extractor.
    let raw = json!({
        "id": 21,
        "result": create_operation_result(create_thread("thread-eph", json!({ "path": null, "ephemeral": true }))),
    })
    .to_string();
    let mut pending = HashSet::new();
    pending.insert(RequestId::Int(21));
    let extracted = extract_thread_resume_response_candidate(
        raw.as_bytes(),
        &ThreadResumeResponseOptions {
            requested_thread_id: Some("thread-eph"),
            enforce_id_agreement: true,
            pending_thread_resume_request_ids: &pending,
        },
    )
    .expect("ephemeral resume still yields a candidate");
    assert!(extracted.thread.ephemeral);
    assert_eq!(extracted.thread.path, None);
}

#[test]
fn rejects_resume_frames_with_duplicate_top_level_keys_or_a_missing_result_thread() {
    let mut pending = HashSet::new();
    pending.insert(RequestId::Int(21));
    let dup = br#"{"id":21,"id":22,"result":{"thread":{"id":"thread-B","path":"/x.jsonl"}}}"#;
    let err = extract_thread_resume_response_candidate(
        dup,
        &ThreadResumeResponseOptions { requested_thread_id: None, enforce_id_agreement: false, pending_thread_resume_request_ids: &pending },
    )
    .expect_err("duplicate top-level key");
    assert_eq!(err, SideEffectError::UnsafeDuplicateKey);

    let no_thread = json!({ "id": 21, "result": { "cwd": "/repo" } }).to_string();
    let err = extract_thread_resume_response_candidate(
        no_thread.as_bytes(),
        &ThreadResumeResponseOptions { requested_thread_id: None, enforce_id_agreement: false, pending_thread_resume_request_ids: &pending },
    )
    .expect_err("result without a thread object");
    assert_eq!(err, SideEffectError::MissingThread);
}
```

And the relay e2e (Task 1's runtime-level red), in `crates/freshell-codex/tests/remote_proxy_relay.rs`, mirroring :306-343 exactly:

```rust
#[tokio::test]
async fn thread_resume_response_is_relayed_unchanged_and_yields_a_candidate() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;

    let request = json!({"id": 9, "method": "thread/resume", "params": {"threadId": "thread-B"}})
        .to_string();
    tui.send(Message::Text(request)).await.unwrap();
    let mut conn = upstream.accept().await;
    let _ = conn.recv_text().await;

    let response = json!({
        "id": 9,
        "result": {"thread": {"id": "thread-B", "path": "/tmp/rollout-B.jsonl", "ephemeral": false}},
    })
    .to_string();
    conn.send_text(response.clone());

    let received = recv_text(&mut tui).await;
    assert_eq!(received, response, "thread/resume response must relay byte-identical");

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::Candidate(candidate) => {
            assert_eq!(candidate.source, CandidateSource::ThreadResumeResponse);
            assert_eq!(candidate.thread.id, "thread-B");
            assert_eq!(candidate.thread.path.as_deref(), Some("/tmp/rollout-B.jsonl"));
        }
        other => panic!("expected a Candidate event, got {other:?}"),
    }

    proxy.close().await;
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-codex remote_proxy_side_effects`
Expected: FAIL — the test module cannot compile: `extract_thread_resume_response_candidate`, `ThreadResumeResponseOptions`, `CandidateSource::ThreadResumeResponse`, and the two error variants are unresolved. That IS the intended missing behavior (a new public API); the behavioral (runtime) red comes from the relay command next.

Run: `cargo test -p freshell-codex --features real-transport --test remote_proxy_relay -- resume`
Expected: FAIL at runtime — the fake upstream's reply relays verbatim but `recv_events` times out: no `thread/resume` candidate is ever emitted today. This proves the frame-level gap, independent of the new-API compile pin.

- [ ] **Step 3: Add the minimal production implementation**

`remote_proxy_side_effects.rs`:

```rust
// enum SideEffectError — insert keeping the alphabetical order:
//   ...IdNotPendingFork, IdNotPendingThreadResume, IdNotPendingThreadStart, ...
//   ...RelativeRolloutPath, ResumeIdMismatch, SameAsParent, ...

// enum CandidateSource (:71-76) — append with its intent comment:
pub enum CandidateSource {
    ThreadStartResponse,
    ThreadStartedNotification,
    ThreadForkResponse,
    /// `thread/resume` response: the TUI switched to an EXISTING thread; the
    /// response's `result.thread` IS the switched-to thread (resume preserves
    /// the caller-requested id).
    ThreadResumeResponse,
}

// after ForkResponseOptions (:134-137):
/// Pending-request-id / requested-thread attribution options for
/// [`extract_thread_resume_response_candidate`]. `thread/resume` answers carry
/// the caller-requested thread id ONLY for threadId-mode resumes — the
/// protocol crate documents that `params.threadId` is ignored when
/// experimental `params.history` or a non-empty `params.path` are supplied —
/// so agreement hard-fails apply only when `enforce_id_agreement` is true.
pub struct ThreadResumeResponseOptions<'a> {
    pub requested_thread_id: Option<&'a str>,
    pub enforce_id_agreement: bool,
    pub pending_thread_resume_request_ids:
        &'a std::collections::HashSet<crate::protocol::RequestId>,
}

// after extract_fork_response_candidate (:434), same scaffolding:
/// Extract a `thread/resume` response candidate. Fails closed on id-set,
/// structure, duplicate-key, or request/response disagreement — the router
/// only ever sees candidates that provably name the thread the TUI asked for.
pub fn extract_thread_resume_response_candidate(
    raw: &[u8],
    options: &ThreadResumeResponseOptions<'_>,
) -> SideEffectResult<RemoteProxyCandidate> {
    let root = scan_root_object(raw)?;
    if has_any_duplicate_key(&root.entries, &["id", "result"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }

    let id = extract_top_level_id(raw, &root.entries)?;
    if !options.pending_thread_resume_request_ids.contains(&id) {
        return Err(SideEffectError::IdNotPendingThreadResume);
    }

    let extracted = extract_result_thread(raw, &root.entries)?;
    if options.enforce_id_agreement {
        if let Some(requested) = options.requested_thread_id {
            if !requested.is_empty() && extracted.thread.id != requested {
                return Err(SideEffectError::ResumeIdMismatch);
            }
        }
    }

    Ok(RemoteProxyCandidate {
        source: CandidateSource::ThreadResumeResponse,
        thread: extracted.thread,
    })
}
```

`remote_proxy.rs`:

```rust
// ConnState (:627-642) + ConnState::new (:635-643) — add beside pending_fork_requests:
    pending_resume_requests: HashMap<RequestId, ResumeRequestAttribution>,

// where (request side, small struct with Default):
//   #[derive(Clone, Debug, Default)]
//   struct ResumeRequestAttribution { thread_id: Option<String>, enforce_agreement: bool }

// client-request dispatch, directly after the fork arm (:1072-1075):
        if method.as_deref() == Some("thread/resume") {
            self.handle_thread_resume_request(conn_id, data, binary, id);
            return;
        }

// new fn beside handle_thread_fork_request (:1128). No rewrite — only the
// params.threadId attribution record, then the normal forward (which records
// pending_methods itself at :1096-1105):
    /// `thread/resume` requests relay UNREWRITTEN (unlike `thread/fork` there is
    /// nothing to strip). The proxy records a bounded-attribution tuple so the
    /// response extractor can enforce request/response agreement ONLY when the
    /// request was threadId-mode: experimental `params.history` or a non-empty
    /// `params.path` make the server IGNORE params.threadId (protocol: "history >
    /// non-empty path > thread_id"), so those modes must never hard-fail.
    fn handle_thread_resume_request(
        &mut self,
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
        id: Option<JsonRpcEnvelopeId>,
    ) {
        if let Some(req_id) = id.as_ref().and_then(envelope_id_to_request_id) {
            if let Some(conn) = self.connections.get_mut(&conn_id) {
                conn.pending_resume_requests.insert(
                    req_id,
                    extract_thread_resume_request_attribution(&data),
                );
            }
        }
        self.forward_client_frame(conn_id, data, binary, id, Some("thread/resume".to_string()));
    }

// Supporting bounded scanner (same json_scan idioms as
// extract_thread_fork_parent_thread_id, remote_proxy.rs:1792):
//
//   fn extract_thread_resume_request_attribution(raw: &[u8])
//       -> ResumeRequestAttribution { thread_id: Option<String>, enforce_agreement: bool }
//
// Returns thread_id from params.threadId (None when absent/empty); enforce
// is false when params.history is present AND non-empty or params.path is a
// non-empty string; otherwise true. ConnState.pending_resume_requests values
// become ResumeRequestAttribution (instead of Option<String>); the response
// handler passes them into ThreadResumeResponseOptions { requested_thread_id:
// attribution.thread_id.as_deref(), enforce_id_agreement: attribution.enforce_agreement, ... }.

// response dispatch (:1236-1262): extend the matched tuple and add the arm
// directly after the fork dispatch — mirroring fork's get-at-dispatch shape:
            let (method, fork_request, resume_request) = match self.connections.get_mut(&conn_id) {
                Some(conn) => {
                    let method = req_id
                        .as_ref()
                        .and_then(|rid| conn.pending_methods.remove(rid));
                    let fork_request = req_id
                        .as_ref()
                        .and_then(|rid| conn.pending_fork_requests.get(rid).cloned());
                    let resume_request = req_id
                        .as_ref()
                        .and_then(|rid| conn.pending_resume_requests.get(rid).cloned());
                    (method, fork_request, resume_request)
                }
                None => (None, None, None),
            };

            if method.as_deref() == Some("thread/start") {
                self.handle_thread_start_response(conn_id, data, binary, req_id);
                return;
            }
            if method.as_deref() == Some("thread/fork") || fork_request.is_some() {
                ... unchanged ...
            }
            if method.as_deref() == Some("thread/resume") || resume_request.is_some() {
                self.handle_thread_resume_response(
                    conn_id,
                    data,
                    binary,
                    req_id,
                    resume_request.flatten().unwrap_or_default(),
                );
                return;
            }
            self.send_to_client(conn_id, data, binary);
            return;

// new fn directly after handle_thread_start_response (:1329-1387). It mirrors
// that handler's discipline exactly: small frames forward REGARDLESS and only
// attempt a candidate; only an oversized frame takes the strict path. It
// removes the pending record at entry, mirroring the fork handler (:1402).
    fn handle_thread_resume_response(
        &mut self,
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
        req_id: Option<RequestId>,
        attribution: ResumeRequestAttribution,
    ) {
        let ResumeRequestAttribution {
            thread_id: requested_thread_id,
            enforce_agreement,
        } = attribution;
        let Some(req_id) = req_id else {
            self.fail_unsafe_upstream_frame(conn_id, Some("thread/resume"), "id_not_pending_resume");
            return;
        };
        if let Some(conn) = self.connections.get_mut(&conn_id) {
            conn.pending_resume_requests.remove(&req_id);
        }

        if data.len() <= MAX_FULL_PARSE_BYTES {
            let mut pending = HashSet::new();
            pending.insert(req_id);
            if let Ok(candidate) = extract_thread_resume_response_candidate(
                &data,
                &ThreadResumeResponseOptions {
                    requested_thread_id: requested_thread_id.as_deref(),
                    enforce_id_agreement: enforce_agreement,
                    pending_thread_resume_request_ids: &pending,
                },
            ) {
                self.emit(RemoteProxyEvent::Candidate(candidate));
            }
            self.send_to_client(conn_id, data, binary);
            return;
        }

        let mut pending = HashSet::new();
        pending.insert(req_id);
        match extract_thread_resume_response_candidate(
            &data,
            &ThreadResumeResponseOptions {
                requested_thread_id: requested_thread_id.as_deref(),
                enforce_id_agreement: enforce_agreement,
                pending_thread_resume_request_ids: &pending,
            },
        ) {
            Ok(candidate) => {
                self.emit(RemoteProxyEvent::Candidate(candidate));
                self.send_to_client(conn_id, data, binary);
            }
            Err(reason) => {
                self.fail_unsafe_upstream_frame(
                    conn_id,
                    Some("thread/resume"),
                    &format!("{reason:?}"),
                );
            }
        }
    }
```

Also extend the module header scan list (:9-11 area: "…relays frames bidirectionally, scanning them via the Slice-1 pure extractors…") with `thread/resume` to keep the doc truthful.

CRITICAL NON-CHANGE (pin it in the commit message): the S5.c identity gate keeps holding ONLY `turn/start` + `thread/fork` (:1003-1005). `thread/resume` must flow immediately — a resume candidate can be the pane's very first identity; holding it would deadlock exactly the kata's incident shape.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-codex remote_proxy_side_effects`
Expected: PASS (all seven new cases plus the existing module).

Run: `cargo test -p freshell-codex --features real-transport --test remote_proxy_relay -- resume`
Expected: PASS.

- [ ] **Step 5: Refactor while green**

Do NOT extract a shared generic across the three response handlers: they intentionally carry distinct legacy-parity semantics (start forwards-on-success, fork rewrites+normalizes, resume verifies agreement), and each already carries a doc'd parity note. No other cleanup is warranted; the new code mirrors existing shapes verbatim by design.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every consumer of the CandidateSource enum and the proxy's ConnState — the whole crate, plus the WS router's existing pins (Task 1 alone compiles them unchanged: a `ThreadResumeResponse` candidate reaching the unmodified router passes the shared guards and falls to D-03/adopt as it does today for any non-fork source; we verify rather than assume).

Run:
```bash
cargo test -p freshell-codex
cargo test -p freshell-codex --features real-transport
cargo fmt --all --check
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings
cargo test -p freshell-ws --lib codex_proxy_route
```
Expected: PASS end to end (including every existing router pin — `first_bind_wins_on_the_same_terminal_d03`, `fork_source_candidates_are_deliberately_ignored`, etc.).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex/src/remote_proxy_side_effects.rs \
        crates/freshell-codex/src/remote_proxy.rs \
        crates/freshell-codex/tests/remote_proxy_relay.rs
git commit -m "feat(codex-proxy): extract thread/resume identity candidates

Detect an in-TUI /resume at the wire: the per-pane remote proxy now records
params.threadId for thread/resume requests and extracts a ThreadResumeResponse
candidate from each valid response (request/response agreement enforced;
resume preserves the requested id, and the response's result.thread is the
thread the TUI switched TO). Frames still relay verbatim; only oversized
frames take the strict extract-or-fail-closed path. The S5.c identity gate's
hold set is unchanged (turn/start + thread/fork only)."
```

---

### Task 2: Route resume candidates into identity; end-to-end rebind + restart coverage

**Files:**
- Modify: `crates/freshell-ws/src/codex_proxy_route.rs` (`route_candidate` :116-211 — insert the resume arm between the bind predicate and D-03; module doc records :21-30 gain the D-RESUME rule)
- Modify: `crates/freshell-ws/src/codex_identity.rs` (doc-only: `CodexRebind` comment :46-49 now covers fork OR resume; the info log at the rebind body drops "fork"-only wording)
- Create: `docs/development/codex-resume-tracking.md` (agent-facing lane model — see Step 3)
- Modify: `AGENTS.md` (one pointer line to the new doc, in the session-identity area)
- Test: `crates/freshell-ws/src/codex_proxy_route.rs` in-module `#[cfg(test)]` (:213+, helpers `test_state` :227, `candidate` :303, `tagged`, `next_frame_matching` :362)
- Test: NEW `crates/freshell-ws/tests/codex_resume_switch_rebind.rs` (scaffold copied from `codex_sidecar_reattach_e2e.rs`: dispatcher shim :228-255, `tui_resume_via_proxy` :503-540, `resume_pair_position` :427, `test_lock` :115, `reattach_rt` :103; server via `common::spawn_server_with_ledger` at `tests/common/mod.rs:546`)
- Test: `crates/freshell-sessions/src/codex_locator_tests.rs` (append one pin — the resume arm leans on `watch_fork` re-point semantics; see Step 1(d))

**Interfaces:**
- Consumes: `CandidateSource::ThreadResumeResponse` + `RemoteProxyCandidate` (Task 1); `rebind_codex_identity` / `CodexRebind` (`codex_identity.rs:48-57, 81-123` — guards: D7 live-owner via `registry.live_session_owner` (registry.rs:2538-2559 — identity arm requires a Running row), A13 no-live-owner-of-new, A8 retired-inclusive + freshagent lane); `adopt_codex_identity` / `CodexAdoption` (:39-45, :60); `CodexTerminalLaunchManager::global().note_session_id` (`launch_lifecycle.rs:892-901` — silent no-op for unknown terminals); `state.codex_locator`'s `watch_fork(&self, terminal_id, session_id) -> bool` (`codex_locator.rs:470` — sync fs-walk snapshotting, must run under `tokio::task::spawn_blocking` per the adopt arm).
- Produces (used by Tasks 3-6 and reviewers): the `D-RESUME` routing rule (recorded in the module doc), `rebind-repointing` fan-out identical between adopt and rebind arms, and two new test files named below for the impact lists.

- [ ] **Step 1: Write the failing behavioral test**

(a) Router pins — append to the in-module tests. New local helper plus five cases:

```rust
fn register_running_codex(state: &WsState, terminal_id: &str) {
    state.registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: terminal_id.to_string(),
        stream_id: format!("s-{terminal_id}"),
        mode: "codex".to_string(),
        resume_session_id: None,
        create_request_id: None,
        created_at: None,
    });
}

#[tokio::test]
async fn resume_candidate_rebinds_a_bound_terminal_through_the_shared_tail() {
    // NOTE: register_running_codex supplies the Running row D7's
    // live_session_owner probes (registry.rs:5548-5565 pins the shape).
    let state = test_state();
    register_running_codex(&state, "term-r");
    route_proxy_event(
        &state,
        tagged("term-r", candidate(
            CandidateSource::ThreadStartResponse, "thread-a", Some("/tmp/rollouts/a.jsonl"), false)),
    )
    .await;
    assert_eq!(
        state.identity.get("term-r").and_then(|i| i.session_id),
        Some("thread-a".to_string())
    );

    let mut frames = state.broadcast_tx.subscribe();
    route_proxy_event(
        &state,
        tagged("term-r", candidate(
            CandidateSource::ThreadResumeResponse, "thread-b", Some("/tmp/rollouts/b.jsonl"), false)),
    )
    .await;

    assert_eq!(
        state.identity.get("term-r").and_then(|i| i.session_id),
        Some("thread-b".to_string())
    );
    // Pinned order: associated FIRST (with previousSessionId), meta.updated SECOND.
    let first = frames.recv().await.unwrap();
    assert!(first.contains("terminal.session.associated"), "{first}");
    assert!(first.contains("thread-b"), "{first}");
    assert!(first.contains("previousSessionId"), "{first}");
    assert!(first.contains("thread-a"), "{first}");
    let second = frames.recv().await.unwrap();
    assert!(second.contains("terminal.meta.updated"), "{second}");
    assert!(second.contains("thread-b"), "{second}");
}

#[tokio::test]
async fn resume_candidate_for_the_currently_bound_thread_is_a_noop() {
    let state = test_state();
    register_running_codex(&state, "term-n");
    route_proxy_event(
        &state,
        tagged("term-n", candidate(
            CandidateSource::ThreadStartResponse, "thread-a", Some("/tmp/rollouts/a.jsonl"), false)),
    )
    .await;
    let mut frames = state.broadcast_tx.subscribe();
    route_proxy_event(
        &state,
        tagged("term-n", candidate(
            CandidateSource::ThreadResumeResponse, "thread-a", Some("/tmp/rollouts/a.jsonl"), false)),
    )
    .await;
    assert_eq!(
        state.identity.get("term-n").and_then(|i| i.session_id),
        Some("thread-a".to_string())
    );
    assert!(
        frames.try_recv().is_err(),
        "a same-thread resume must not emit identity frames"
    );
}

#[tokio::test]
async fn resume_candidate_on_an_unbound_terminal_adopts_it_as_the_first_identity() {
    let state = test_state();
    let mut frames = state.broadcast_tx.subscribe();
    route_proxy_event(
        &state,
        tagged("term-u", candidate(
            CandidateSource::ThreadResumeResponse, "thread-d", Some("/tmp/rollouts/d.jsonl"), false)),
    )
    .await;
    assert_eq!(
        state.identity.get("term-u").and_then(|i| i.session_id),
        Some("thread-d".to_string())
    );
    let first = frames.recv().await.unwrap();
    assert!(first.contains("terminal.session.associated"), "{first}");
    assert!(
        !first.contains("previousSessionId"),
        "a first bind carries no previousSessionId: {first}"
    );
}

#[tokio::test]
async fn resume_rebind_is_refused_when_the_target_thread_is_live_owned_elsewhere() {
    let state = test_state();
    register_running_codex(&state, "term-1");
    register_running_codex(&state, "term-2");
    route_proxy_event(
        &state,
        tagged("term-1", candidate(
            CandidateSource::ThreadStartResponse, "thread-a", Some("/tmp/rollouts/a.jsonl"), false)),
    )
    .await;
    route_proxy_event(
        &state,
        tagged("term-2", candidate(
            CandidateSource::ThreadStartResponse, "thread-c", Some("/tmp/rollouts/c.jsonl"), false)),
    )
    .await;
    let mut frames = state.broadcast_tx.subscribe();
    route_proxy_event(
        &state,
        tagged("term-1", candidate(
            CandidateSource::ThreadResumeResponse, "thread-c", Some("/tmp/rollouts/c.jsonl"), false)),
    )
    .await;
    // A13: term-2 live-owns thread-c — term-1's binding must not move.
    assert_eq!(
        state.identity.get("term-1").and_then(|i| i.session_id),
        Some("thread-a".to_string())
    );
    assert!(frames.try_recv().is_err(), "a refused rebind must not emit identity frames");
}

#[tokio::test]
async fn d03_first_bind_wins_still_governs_non_resume_sources() {
    let state = test_state();
    register_running_codex(&state, "term-d");
    route_proxy_event(
        &state,
        tagged("term-d", candidate(
            CandidateSource::ThreadStartResponse, "thread-a", Some("/tmp/rollouts/a.jsonl"), false)),
    )
    .await;
    let mut frames = state.broadcast_tx.subscribe();
    route_proxy_event(
        &state,
        tagged("term-d", candidate(
            CandidateSource::ThreadStartedNotification, "thread-z", Some("/tmp/rollouts/z.jsonl"), false)),
    )
    .await;
    assert_eq!(
        state.identity.get("term-d").and_then(|i| i.session_id),
        Some("thread-a".to_string())
    );
    assert!(frames.try_recv().is_err());
}
```

(b) Integration file — NEW `crates/freshell-ws/tests/codex_resume_switch_rebind.rs`. Copy the scaffold head from `codex_sidecar_reattach_e2e.rs` verbatim (header comment, `#![cfg(target_os = "linux")]`, imports, `fixture_path`, `codex_dispatcher`, `reattach_rt`, `test_lock`), and per `#[test]` fn body runs `reattach_rt().block_on(...)` under `let _g = test_lock().lock().await;`. Server: `common::spawn_server_with_ledger(cli_commands(codex spec), &ledger_dir)` (common/mod.rs:546 — real `PaneLedger`; `codex_locator: None` is CORRECT here: no locator means the startup window can never bind anything, which is exactly the kata's expired-window state, without waiting real seconds). Two test fns:

```rust
// GATE-TIMELINE CONSTRAINT (validated Stage 2, LB4): the fresh-pane candidate-
// capture timer fires 45s after PROXY START and then fails closed (held frames
// answered -32000, RepairTrigger emitted log-only, all relay socket pairs
// closed; the pane PTY survives). thread/resume is never held, even then, and
// a TUI reconnect gets a fresh pair on which resume still flows — but for
// determinism BOTH fns must finish their whole drive well inside 45s from pane
// spawn (their waits are seconds). Assert NOTHING about relay state beyond that
// window.

// fn resume_switch_after_window_expiry_adopts_and_converges_everywhere()
//   (Kata acceptance bullet a + the incident shape: pane UNBOUND at resume time.)
// 1. Arrange: temp CODEX_HOME; fixture durable writes ON
//    (FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES=1); behavior JSON seeds
//    threadResumeThreadId = "thread-durable"
//    and threadResumeRolloutPath = <abs path of the rollout the fixture's
//    ensureDurableArtifact wrote under CODEX_HOME>.
// 2. Spawn the server with the real ledger; connect a capture client
//    (common::connect_and_capture_inventory :910) partway, then create a
//    managed codex terminal through the WS handshake (terminal.create, mode
//    codex — same drive as codex_sidecar_reattach_e2e.rs's create legs).
// 3. Baseline: assert NO terminal.session.associated frame has arrived and the
//    terminal inventory entry carries no sessionRef — the startup locator
//    window "expired" (no locator wired) without a bind.
// 4. Play the TUI: tui_resume_via_proxy(proxy_url, "thread-durable")
//    (the proxy URL is the terminal's --remote target — read it the way the
//    reattach file extracts it for its TUI legs).
// 5. Assert ordered frames via `common::next_frame_of_type` (:1089):
//    terminal.session.associated { terminalId, sessionRef { codex,
//    "thread-durable" }, NO previousSessionId key } THEN
//    terminal.meta.updated upsert { provider codex, sessionId "thread-durable" }.
// 6. Assert server homes: the live server's Arc<PaneLedger> resolve shows a
//    bound row for codex/thread-durable with this pane; registry meta's
//    resume_session_id == "thread-durable" (read via the inventory follow-up).
// 7. Assert tabs-sync convergence: push a minimal tabs.sync frame whose pane
//    payload carries sessionRef codex:thread-durable (frame shape per
//    tests/ui_layout_sync.rs), then read the persisted tabs-snapshot generation
//    under the test home and assert it contains the new sessionRef
//    (validation: tabs_persist_validation.rs:248-275 provider==mode gate).
// 8. Assert the sidecar record carries the new id: read via
//    CodexSidecarStore::new(<home>/.freshell/rust-codex-sidecars).load_all()
//    (freshell_codex exports it — the reattach file's imports at :50-56) and
//    match the record by ownership; assertions: record.session_id ==
//    "thread-durable". On-disk naming (validated Stage 2, LB5): the raw JSON
//    key is camelCase "sessionId", ABSENT until the first note
//    (skip_serializing_if), same file overwritten on further switches.
// 9. Idle-reap / reconnect / restart share one seam — the resume id pinned in
//    fn2 below covers it; this fn closes by asserting a RESTORE create (the
//    client's post-reap re-issue) spawns argv whose LAST two entries are
//    ["resume", "thread-durable"] (dispatcher dump via CODEX_ARGV_CAPTURE_PATH;
//    resume_pair_position :427 shape).

// fn repeat_resume_switches_supersede_and_restart_resumes_the_latest()
//   (Kata acceptance bullets c + d: repeat-switch supersession + restart
//    resumes the exact durable thread in the same logical pane.)
// 1. Bind A first: TUI drives thread/start through the proxy (behavior knobs
//    threadStartThreadId = "thread-a", threadStartRolloutPath = <durably
//    written abs path>) — a normal ThreadStartResponse candidate adopts A.
// 2. thread/resume → "thread-b": assert the frame carries previousSessionId
//    "thread-a" and sessionRef codex:thread-b; assert the ledger RETIRED A's
//    row (state Retired, retiredReason Superseded, supersededBy { codex,
//    thread-b }) and shows thread-b bound.
// 3. thread/resume → "thread-c": previousSessionId "thread-b"; ledger: B now
//    Retired + supersededBy thread-c; A unchanged; C bound. Registry meta C.
// 4. Restart leg: drop the harness server; respawn it against the SAME
//    ledger_dir and CODEX_HOME (spawn_server_with_ledger's header documents
//    "Two servers pointed at the same dir model a restart"). Drive the
//    recovery: a fresh read-only PaneLedger over the dir resolves the
//    ledger's authoritative chain to thread-c (pane_ledger_restore.rs shape);
//    then a restore-style terminal.create — the client would carry the
//    persisted sessionRef { codex, thread-c } — produces spawn argv with
//    ["resume", "thread-c"] as its final pair and NEVER ["resume", "thread-a"],
//    and a pane-reconcile claim presenting STALE id "thread-a" is answered
//    with the chain terminus thread-c (reconcile rung 2b, reconcile.rs:135-153;
//    the frame drive follows tests/pane_reconcile.rs's verdict flow).
// 5. Failure-state pin for the knife's edge: with the same harness but the
//    fixture resumed path DELETED from CODEX_HOME, the restore gate
//    (gate_wire_resume → resume_validation::validate_wire_resume,
//    terminal.rs:2191-2204/2116-2136) demotes to a fresh spawn instead of
//    resuming a ghost — assert argv lacks ["resume", ...] entirely for a
//    dead id (fail-closed, mirroring resume_validation_gate.rs's existing
//    positive-absence leg). This is where the restart story proves it never
//    silently recovers the WRONG session.
```

(c) Playwright e2e — NEW `test/e2e-browser/specs/codex-resume-switch-rust.spec.ts`, registration edits in `test/e2e-browser/playwright.config.ts` (add the filename to BOTH `RUST_ONLY_SPECS` — the block holding `/codex-terminal-restore-rust\.spec\.ts$/` at :238 — AND the `rust-chromium` `testMatch` list next to `/opencode-rebind-rust\.spec\.ts$/` at :493; with the block's one-line comment style explaining this is a rust-only capability). The spec structure mirrors opencode-rebind-rust.spec.ts (WsCapture setup via helpers/ws-capture.ts, pane induction per its openOpencodePane pattern, and its restart/respawn legs), on the MANAGED lane by default (do NOT set `FRESHELL_CODEX_MANAGED_LAUNCH=0`), with the codex dual-role shim from `test/e2e-browser/fixtures/codex-dual-role.ts`:

Skeleton (each leg's assertions are exact; helpers per the named precedents):

```ts
test('codex pane follows an in-TUI /resume across a server restart (rust)', async () => {
  // ARRANGE: e2e server handle owned by the spec; codex dual-role shim; temp
  // CODEX_HOME with FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES=1 and behavior
  // knobs: threadStartThreadId/…RolloutPath seed A's durable rollout;
  // threadResumeThreadId/…RolloutPath seed B's. A WsCapture is attached to the
  // server's /ws (token from the server handle).
  // LEG 1 (bind A): open the app, create a codex pane via the picker
  //   (codex-dual-role shim; the pane's terminal boots through the managed
  //   launch). From the spec process (node `ws`, like the resume-button/restore
  //   specs drive frames) dial the pane's --remote proxy URL — read from the
  //   argv the dispatcher shim dumped for the TUI launch (the capture file the
  //   shim writes) — complete initialize/initialized, and send
  //   thread/start{...} (params per the fake's start shape). The locator
  //   path may also bind A; wait for terminal.session.associated for A via
  //   capture.waitFor.
  // LEG 2 (the switch): send thread/resume{threadId: B} through the same
  //   proxy socket. Assert in order:
  //   - capture.waitFor terminal.session.associated with sessionId B AND
  //     previousSessionId === A (order: then terminal.meta.updated for B);
  //   - in-page Redux fold: the pane's content sessionRef is codex:B
  //     (`harness.getPaneLayout` — opencode-rebind's :360 area);
  //   - sidebar: row for codex:B gains data-is-running / data-has-tab on
  //     EXACTLY that pane's row; whatever A-row exists is NOT running
  //     (`data-is-running` absent) and there is still exactly ONE B row
  //     (locator asserts, opencode-rebind redux/sidebar legs' style);
  //   - tabs-sync persistence: the next pushed snapshot (the fold's
  //     flushPersistedLayoutNow) includes payload sessionRef codex:B —
  //     assert via the harness's snapshot read or a GET the server handle
  //     exposes (deploy-tab-diff-rust.spec.ts reads this surface;
  //     follow its accessor).
  // LEG 3 (restart): restart the owned Rust server (the restore specs'
  //   restart helper via RustServer), reload the page, wait for reconnect.
  //   Assert: the pane's terminal respawned with argv whose last pair is
  //   ["resume", B] (the shim's argv capture); the pane layout still binds
  //   codex:B; the B sidebar row is running again in exactly that pane; A
  //   never resurfaces as running.
})
```

(Leg 2's "previousSessionId === A" is the crisp isolation of the server arm from client-only drift. Keep the entire spec outside `CLOUD_SKIP_SPECS`: all fakes self-installed, per codex-dual-role.ts + opencode-rebind conventions.)

Timeline bound (validated Stage 2, LB4): all legs must fit within the fresh pane's 45s candidate-capture window from pane spawn (the legs' waits are seconds). Should a leg ever overrun it, the proxy has already torn the first socket pair down fail-closed; the TUI's own reconnect re-establishes one and resume flows on it (the gate is then Failed but thread/resume is never held) — the spec must not assert anything about the FIRST pair surviving such an overrun.

(d) Fork-watch re-point pin (validated Stage 2 / LB2 informational gap): `watch_fork(terminal, NEW)` REPLACES the one per-terminal watch (HashMap keyed on terminal_id, doc-pinned overwrite semantics) but nobody unit-pins that a re-pointed watch silences the OLD lineage's forks. Append to `crates/freshell-sessions/src/codex_locator_tests.rs` (mirroring the refused-rebind rewatch test's fixture idioms):

```rust
#[test]
fn repointed_fork_watch_silences_the_old_lineage() {
    // watch_fork(t, A); write a fork-child rollout of A (forked_from_id A,
    // thread_source user) → tick_forks yields a hit for t. Then watch_fork(t, B);
    // write ANOTHER fork child of A → tick_forks yields NOTHING for t (the
    // OLD-lineage watch is gone); write a fork child of B → tick_forks hits t.
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --lib codex_proxy_route`
Expected: FAIL — the rebind case (D-03 swallows the resume candidate: identity never leaves "thread-a", and the awaited frames never arrive), the same-id noop case (today a resume candidate falls THROUGH the D-03 ignore when ids match and re-runs the whole adopt tail including broadcasts, failing the no-frames assertion), and the A13 refusal case (refusal path unimplemented → binding wrongly moves) all fail for the intended missing arm. The unbound-adopt case may pass immediately (fall-through into the existing adopt tail — that IS the design) — state that in the log.

Run: `cargo test -p freshell-ws --test codex_resume_switch_rebind -- --test-threads=1`
Expected: FAIL — fn1 times out awaiting the `previousSessionId`/convergence assertions' foundations; concretely fn2's repeated-switch leg sees binding stuck at "thread-a".

Run: `scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/codex-resume-switch-rust.spec.ts`
Expected: FAIL at LEG 2 — no rebind frame arrives within the capture deadline ('WsCapture: timed out … waiting for rebind …'), proving the end-to-end gap the server arm closes.

- [ ] **Step 3: Add the minimal production implementation**

Two files change.

`crates/freshell-ws/src/codex_proxy_route.rs` — insert the resume arm immediately AFTER the id/path bind predicate (:136-147) and BEFORE the D-03 block (:148-160). Both the predicate and D-03 stay byte-identical for non-resume sources. Also record the new rule in the module doc (insert after the D-FORK paragraph, :21-30 area):

```rust
//! D-RESUME RULE (recorded; kata 3gvd): a `thread/resume` RESPONSE candidate is
//! the ONLY source allowed to MOVE an existing binding — it is the TUI's
//! server-authoritative, request-correlated report of an in-TUI switch. D-03
//! still governs thread/start and thread/started: first bind wins there.
//! Resume of the currently bound thread is a no-op (the pane is already
//! showing exactly that thread).
```

```rust
    // D-RESUME: a thread/resume response candidate reports an in-TUI switch to
    // an EXISTING durable thread (request-correlated; the disk fork lane
    // structurally cannot see resume-to-existing — codex_locator.rs:65
    // documents CLI resumes APPEND to the existing rollout).
    if candidate.source == CandidateSource::ThreadResumeResponse {
        let existing_codex_id: Option<String> = match state.identity.get(terminal_id) {
            Some(existing) if existing.provider.as_deref() == Some("codex") => {
                existing.session_id.clone()
            }
            _ => None,
        };
        match existing_codex_id.as_deref() {
            // Unbound pane (the kata's incident shape — the startup window
            // expired unresolved): the resume IS its first identity; fall
            // through to the adoption tail below.
            None => {}
            // Resume of the currently bound thread: nothing moves. A no-op, not
            // a re-adopt — never re-broadcast a no-change identity move.
            Some(current) if current == candidate.thread.id => {
                tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
                    "codex_proxy_resume_candidate_noop: terminal already bound to the resumed thread");
                return;
            }
            // A genuine switch: move the binding through the EXISTING rebind
            // tail (identity store, registry meta, fsynced ledger supersession,
            // associated+meta.updated frames, activity hub re-key + rollout
            // re-attach). rebind_codex_identity's guards (D7/A13/A8) own
            // refusal; a refusal logs its own reason and moves nothing.
            Some(old_id) => {
                // The bind predicate above guarantees Some + absolute.
                let rollout_path = candidate
                    .thread
                    .path
                    .as_deref()
                    .map(Path::new)
                    .filter(|path| path.is_absolute())
                    .expect("resume candidates pass the absolute-path guard above");
                let rebound = crate::codex_identity::rebind_codex_identity(
                    state,
                    crate::codex_identity::CodexRebind {
                        terminal_id,
                        old_session_id: old_id,
                        new_session_id: &candidate.thread.id,
                        rollout_path,
                        cwd,
                    },
                )
                .await;
                if !rebound {
                    return;
                }
                // Fan-out parity with the adopt tail below:
                // (1) the resumed id is the durable sidecar record's
                //     restore-time reattach key — without this, restart-time
                //     claim_for_session finds the surviving sidecar by the OLD
                //     id only (verified gap).
                CodexTerminalLaunchManager::global()
                    .note_session_id(terminal_id, &candidate.thread.id)
                    .await;
                // (2) the disk fork lane must now watch the NEW thread, so a
                //     fork from it still rebinds (tick_forks auto-advances only
                //     its own disk-detected forks). Blocking pool, same as the
                //     adopt arm (bounded fs walk).
                if let Some(locator) = &state.codex_locator {
                    let watch_locator = std::sync::Arc::clone(locator);
                    let terminal_id = terminal_id.to_string();
                    let thread_id = candidate.thread.id.clone();
                    if let Err(join_error) = tokio::task::spawn_blocking(move || {
                        watch_locator.watch_fork(&terminal_id, &thread_id);
                    })
                    .await
                    {
                        tracing::warn!(
                            error = %join_error,
                            "codex_watch_fork_panicked: blocking watch_fork task panicked"
                        );
                    }
                }
                return;
            }
        }
    }
```

`crates/freshell-ws/src/codex_identity.rs` — doc-only truthfulness edits (no behavior change):
- `CodexRebind`'s comment (:46-49): the move now covers "forked OR `/resume`-switched (in-TUI flows)" — say so, since the disk lane still documents its own provence.
- The rebind body's info log (": codex_rebind: in-TUI fork detected; moving pane identity") becomes "codex_rebind: in-TUI thread switch detected; moving pane identity" — resume switches flow through the same log.

Also write `docs/development/codex-resume-tracking.md` (short, for future agents): the three codex identity lanes (startup rollout locator window, disk fork watch, remote-proxy resume arm), the shared adopt/rebind tail and its fan-out (identity store, registry meta, ledger supersession fsync-before-announce, associated/meta.updated order, activity re-pointing, sidecar reattach key, fork-watch re-registration), the recovery funnel (reap/reconnect/restart → `codex resume <id>`), the fail-closed continuity gates (`deploy-tab-diff` verdicts), and the unmanaged-lane/downtime residuals. Link it from AGENTS.md's existing agent/development-doc listing (single line, same format as the neighboring `docs/development/…` references such as the test-sandbox pointer).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --lib codex_proxy_route`
Expected: PASS (all existing pins plus the five new cases).

Run: `cargo test -p freshell-ws --test codex_resume_switch_rebind -- --test-threads=1`
Expected: PASS (both fns).

Run: `scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/codex-resume-switch-rust.spec.ts`
Expected: PASS.

- [ ] **Step 5: Refactor while green**

The spawn_blocking `watch_fork` stanza now appears twice in this file (adopt arm :191-205, resume arm above) with identical semantics. Extract a private helper local to this module:

```rust
/// Repoint the disk fork lane's watch at `thread_id` (adopt arm and D-RESUME
/// rebind arm) — spawn_blocking because watch_fork does a bounded fs walk.
async fn repoint_codex_fork_watch(state: &WsState, terminal_id: &str, thread_id: &str) { … }
```

and have both arms call it. Do NOT touch `codex_association.rs`'s refused-path re-registration call in this task (Task 3 owns that file). Keep the D-03/D-FORK/D-RESUME doc records aligned with the code.

- [ ] **Step 6: Run impacted-test verification**

The resume arm sits on the single-writer identity path; the impacted set is every suite crossing codex identity, the proxy router, the ledger, restore/reap, and the activity hub:

Run:
```bash
cargo test -p freshell-ws --lib
cargo test -p freshell-sessions codex_locator
cargo test -p freshell-ws --test codex_resume_switch_rebind -- --test-threads=1
cargo test -p freshell-ws --test codex_fork_rebind -- --test-threads=1
cargo test -p freshell-ws --test codex_sidecar_reattach_e2e -- --test-threads=1
cargo test -p freshell-ws --test codex_session_ref_resume
cargo test -p freshell-ws --test codex_locator_activity
cargo test -p freshell-ws --test codex_candidate_inert
cargo test -p freshell-ws --test rest_locator_identity
cargo test -p freshell-ws --test pane_ledger_restore
cargo test -p freshell-ws --test pane_reconcile
cargo test -p freshell-ws --test resume_validation_gate
cargo test -p freshell-ws --test restore_spawn_gate
cargo test -p freshell-codex --features real-transport
cargo fmt --all --check
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/codex-resume-switch-rust.spec.ts
scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/opencode-rebind-rust.spec.ts
```
Expected: PASS across the board.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/codex_proxy_route.rs \
        crates/freshell-ws/src/codex_identity.rs \
        crates/freshell-ws/tests/codex_resume_switch_rebind.rs \
        crates/freshell-sessions/src/codex_locator_tests.rs \
        test/e2e-browser/specs/codex-resume-switch-rust.spec.ts \
        test/e2e-browser/playwright.config.ts \
        docs/development/codex-resume-tracking.md AGENTS.md
git commit -m "feat(freshell-ws): rebind codex panes on in-TUI thread/resume (D-RESUME)

A thread/resume response candidate is the only candidate source allowed to
move an existing binding: the pane switched threads in-TUI, and the resumed
id is server-authoritative (request-correlated extraction from Task 1).
Unbound panes adopt the resumed id as their first identity (the kata's
expired-window incident shape); a same-thread resume is a no-op; a switch
moves through rebind_codex_identity (ledger supersession fsynced before the
terminal.session.associated + terminal.meta.updated frames, previousSessionId
included), then re-points the sidecar reattach key and the disk fork watch at
the new thread. D-03 still governs thread/start and thread/started."
```

---

### Task 3: Advance the sidecar reattach key on disk fork-lane rebinds

**Files:**
- Modify: `crates/freshell-ws/src/codex_association.rs` (the `tick_forks` consumer loop's success path, :220-254)
- Test: `crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs` (extend with one fn — it owns the managed-launch harness where sidecar records exist)

**Interfaces:**
- Consumes: the published fork event shape the loop already destructures (`f.terminal_id`, `f.new_session_id`; the loop's `locator` Arc), `CodexTerminalLaunchManager::global().note_session_id` (`launch_lifecycle.rs:892-901`, silent no-op for unmanaged terminals — this task's behavior shows up only for managed panes, which is exactly where the sidecar store exists).
- Produces: the disk fork lane's fan-out parity with the proxy resume arm (Task 2) — after ANY mid-life identity move, the sidecar record's reattach key matches the pane's current binding.

**Verified gap (this is a real pre-existing bug the rebind work makes worth fixing):** the store record is the restore-time reattach index (`claim_for_session`, `sidecar_reconcile.rs:187+`), and only the router's adopt tail ever calls `note_session_id`. A disk-lane fork rebind (`tick_forks` → `rebind_codex_identity`, codex_association.rs:220-231) moves the identity but leaves the record stale; a server restart would then try to claim the survivor sidecar by the OLD id and miss. Task 2 covered the resume arm; this covers the fork lane.

- [ ] **Step 1: Write the failing behavioral test**

Extend `crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs` with:

```rust
/// Disk-lane fork rebind must advance the durable sidecar record's
/// session_id: it is the restart-time claim key (claim_for_session).
#[test]
fn disk_fork_rebind_advances_the_sidecar_record() {
    reattach_rt().block_on(async {
        let _g = test_lock().lock().await;
        // Arrange + drive the file's existing managed-create flow, then:
        // 1. Bind A through the proxy (tui: thread/start with the behavior
        //    knobs; the adopt arm registers watch_fork(A) + note_session_id(A)).
        // 2. Simulate the in-TUI fork the DISK lane owns: write a NEW rollout
        //    file under the harness CODEX_HOME whose session_meta carries
        //    payload.id = "thread-b", forked_from_id = "thread-a", and
        //    thread_source = "user" (the predicate set codex_locator.rs's
        //    ForkWatch requires; file layout per the locator-tests writer).
        // 3. Wait out the fork sweep tick (cadence per the file's existing
        //    waits; tick_forks → rebind_codex_identity).
        // 4. Assert identity is now "thread-b" (the pre-existing behavior),
        //    THEN read the sidecar store record for this terminal from the
        //    harness home's rust-codex-sidecars dir and assert
        //    record.session_id == "thread-b".
        // Today step 4's store assertion FAILS: the rebind never updated it.
    })
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test codex_sidecar_reattach_e2e -- --test-threads=1 disk_fork_rebind`
Expected: FAIL — identity moves to `thread-b` but the sidecar record still says `thread-a`. (Confirm the failure message shows exactly that mismatch, not a harness/setup accident.)

- [ ] **Step 3: Add the minimal production implementation**

In `codex_association.rs`'s fork consumer loop, after the successful rebind (the `if !ok { …refused arm… }` block's sibling success path, :222-254):

```rust
    for f in forks {
        let ok = crate::codex_identity::rebind_codex_identity(
            state,
            crate::codex_identity::CodexRebind {
                terminal_id: &f.terminal_id,
                old_session_id: &f.old_session_id,
                new_session_id: &f.new_session_id,
                rollout_path: &f.rollout_path,
                cwd: f.cwd.as_deref(),
            },
        )
        .await;
        if ok {
            // Fan-out parity with the proxy resume arm (D-RESUME): the new
            // thread id is the durable sidecar record's restore-time reattach
            // key. Silent no-op for unmanaged terminals (no record exists).
            CodexTerminalLaunchManager::global()
                .note_session_id(&f.terminal_id, &f.new_session_id)
                .await;
            continue;
        }
        // …existing refused arm unchanged (warn + watch re-registration on OLD)…
    }
```

The watch does NOT need re-registration on success: `tick_forks` already advanced it to the child id (`codex_locator.rs:557-559` region — documented by the refused arm's own comment below it).

Add the import if the file lacks it: `use freshell_codex::launch_lifecycle::CodexTerminalLaunchManager;`.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test codex_sidecar_reattach_e2e -- --test-threads=1 disk_fork_rebind`
Expected: PASS.

- [ ] **Step 5: Refactor while green**

No refactor: the inserted arm is three lines and deliberately mirrors the resume arm's comment shape; a shared "post-rebind fan-out" helper would cross the router/association module boundary for two call sites — YAGNI.

- [ ] **Step 6: Run impacted-test verification**

Rebind consumers: the fork lane owner suite, every identity suite, the ledger suites:

Run:
```bash
cargo test -p freshell-ws --test codex_sidecar_reattach_e2e -- --test-threads=1
cargo test -p freshell-ws --test codex_fork_rebind -- --test-threads=1
cargo test -p freshell-ws --test codex_resume_switch_rebind -- --test-threads=1
cargo test -p freshell-ws --test codex_locator_activity
cargo test -p freshell-ws --lib
cargo fmt --all --check
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings
```
Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/codex_association.rs \
        crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs
git commit -m "fix(freshell-ws): advance the sidecar reattach key on disk fork rebinds

The disk fork lane (tick_forks → rebind_codex_identity) moved pane identity
but never updated the durable sidecar record's session_id — a restart's
claim_for_session would have searched by the old id. Route the fork lane's
successful rebinds through note_session_id, matching the proxy resume arm."
```

---

### Task 4: Client — clear the superseded session's running state on identity move

**Files:**
- Modify: `src/store/sessionsSlice.ts` (`patchProjectRunningState` :278-320)
- Test: `test/unit/client/store/sessionsSlice.test.ts` (new describe — the reducer has NO direct running-state coverage today; existing wiring-level coverage is `App.ws-bootstrap.test.tsx:1830+` and `terminal-invalidation-handler.test.ts:160`)
- Test: `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts` (one combined presentation case)

**Interfaces:**
- Consumes: the existing reducer contract — `patchSessionRunningStateFromTerminalMeta(state, { upsert: TerminalMetaRecord[], remove: string[] })` (registration :497-510 applies `patchProjectRunningState` to `state.projects` and every window's `projects`); the invalidation handler's call shape is unchanged (`src/lib/terminal-invalidation-handler.ts:85-105`), so no signature change crosses the seam.
- Produces: a row claiming a terminal now reports `isRunning: false` the moment the server says that terminal belongs to a DIFFERENT session key — without waiting for the 50ms-debounced session-window refresh.

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/client/store/sessionsSlice.test.ts`, append a new describe (imports/builders already exist in the file):

```ts
describe('patchSessionRunningStateFromTerminalMeta identity moves', () => {
  it('moves running state off the superseded session row on a rebind (old → cleared, new → running)', () => {
    // projects [/repo]: codex:old-thread { isRunning: true, runningTerminalId: 't-1' },
    //                   codex:new-thread (idle)
    const state = <build slice state via the file's existing conventions>
    store.dispatch(patchSessionRunningStateFromTerminalMeta({
      upsert: [{ terminalId: 't-1', provider: 'codex', sessionId: 'new-thread', updatedAt: Date.now() } as any],
      remove: [],
    }))
    const oldRow = <find 'codex:old-thread' in state.projects[0].sessions>
    const newRow = <find 'codex:new-thread'>
    expect(oldRow.isRunning).toBe(false)
    expect(oldRow.runningTerminalId).toBeUndefined()
    expect(newRow.isRunning).toBe(true)
    expect(newRow.runningTerminalId).toBe('t-1')
    // window surfaces: also assert one state.windows[...] project got the same
    // treatment (the reducer loops all windows).
  })

  it('a same-key refresh keeps the row running (no false clear)', () => {
    // old-thread running under t-1; upsert again for codex:old-thread/t-1
    // → isRunning stays true, runningTerminalId stays 't-1'.
  })

  it('remove entries still clear rows (pre-existing contract, pinned)', () => {
    // remove: ['t-1'] → old row cleared.
  })

  it('upserts without provider/sessionId still mark the terminal cleared (pre-existing contract)', () => {
    // upsert: [{ terminalId: 't-1', updatedAt }] (no provider) → old row cleared.
  })
})
```

And in `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts` append one presentation-level pin combining the two halves (terminalDirectory carrying the NEW ref immediately while sessions rows still lag):

```ts
it('rebind presentation: the new session row is running, the superseded row is not, and no duplicate rows exist', () => {
  // state: sessions rows codex:old (just-cleared by the reducer fix — emulate
  // via isRunning: false) and codex:new (isRunning: true, runningTerminalId t-1);
  // terminals prop: [{ terminalId: 't-1', mode: 'codex', status: 'running',
  //   sessionRef: { provider: 'codex', sessionId: 'new' }, … }] (the file's
  //   BackgroundTerminal fixture shape).
  // Assert the built items: the codex:new item {isRunning: true,
  // runningTerminalId: 't-1', hasTab as modeled}; codex:old is present at most
  // once and NOT running; exactly one item claims t-1.
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/sessionsSlice.test.ts -t "identity moves"`
Expected: FAIL — the first case fails: `oldRow.isRunning` stays `true` (the reducer never clears the superseded row on an identity-move upsert — exactly the sidebar staleness seam). The three contract pins PASS and guard the baseline.

Run: `npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts`
Expected: FAIL on the new presentation case (it models the reducer-fixed post-state but goes through the shipped selector; the stale-running duplicate is only avoidable once the reducer moves the claim).

- [ ] **Step 3: Add the minimal production implementation**

`src/store/sessionsSlice.ts` — inside `patchProjectRunningState`, keep every existing line's behavior and add the identity-move clearance. Full replacement body:

```ts
function patchProjectRunningState(
  projects: ProjectGroup[],
  payload: {
    upsert: TerminalMetaRecord[]
    remove: string[]
  },
) {
  const clearedTerminalIds = new Set(payload.remove)
  for (const record of payload.upsert) {
    if (!record.provider || !record.sessionId) {
      clearedTerminalIds.add(record.terminalId)
    }
  }

  const runningBySessionKey = new Map<string, string>()
  for (const record of payload.upsert) {
    if (!record.provider || !record.sessionId) continue
    runningBySessionKey.set(`${record.provider}:${record.sessionId}`, record.terminalId)
  }

  // Identity moves (server-side rebind): an upsert saying terminal T now
  // belongs to session key X implies every OTHER row's stale claim on T is
  // over. terminalId → its current session key per this payload.
  const currentKeyByTerminalId = new Map<string, string>()
  for (const record of payload.upsert) {
    if (record.provider && record.sessionId) {
      currentKeyByTerminalId.set(record.terminalId, `${record.provider}:${record.sessionId}`)
    }
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      const sessionRecord = session as typeof session & {
        isRunning?: boolean
        runningTerminalId?: string
      }
      if (sessionRecord.runningTerminalId) {
        const rowKey = `${session.provider || 'claude'}:${session.sessionId}`
        const movedToKey = currentKeyByTerminalId.get(sessionRecord.runningTerminalId)
        if (
          clearedTerminalIds.has(sessionRecord.runningTerminalId)
          || (movedToKey !== undefined && movedToKey !== rowKey)
        ) {
          sessionRecord.isRunning = false
          sessionRecord.runningTerminalId = undefined
        }
      }

      const runningTerminalId = runningBySessionKey.get(`${session.provider || 'claude'}:${session.sessionId}`)
      if (runningTerminalId) {
        sessionRecord.isRunning = true
        sessionRecord.runningTerminalId = runningTerminalId
      }
    }
  }
}
```

Ordering inside one pass — clear-before-set per row is per-row independent (a row can only be the superseded one or the new one, never both, because keys differ by construction); a payload containing BOTH the old row's remove-less disappearance AND the new row's claim resolves deterministically: superseded rows clear, the new row sets. Multiple reshapes in one payload behave entry-wise as before.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/sessionsSlice.test.ts -t "identity moves"`
Expected: PASS.

Run: `npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor while green**

No refactor: the two maps merge into one pass of work and the block keeps the file's established shape; collapsing `runningBySessionKey` and `currentKeyByTerminalId` into one map keyed on terminalId would erase the distinct intent (set-the-new vs clear-the-old) for a negligible win — leave them separate and named.

- [ ] **Step 6: Run impacted-test verification**

Consumers of running state: the sidebar selectors, the association fold, the invalidation handler wiring, and the ws bootstrap pipeline:

Run:
```bash
npm run test:vitest -- run \
  test/unit/client/store/sessionsSlice.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts \
  test/unit/client/lib/terminal-invalidation-handler.test.ts \
  test/unit/client/lib/terminal-session-association.test.ts \
  test/unit/client/components/App.ws-bootstrap.test.tsx
```
Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/sessionsSlice.ts \
        test/unit/client/store/sessionsSlice.test.ts \
        test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
git commit -m "fix(client): clear the superseded session's running state on identity move

terminal.meta.updated carrying a terminal's NEW session key now also clears
isRunning/runningTerminalId on the session row the terminal just left, instead
of leaving the old row running until the session-window refresh replaces it.
This is the rebind path's last stale-attribution seam in the sidebar."
```

---

### Task 5: Client — a non-user-set tab title follows the rebinding to the new session

**Files:**
- Modify: `src/lib/terminal-session-association.ts` (:62-156)
- Test: `test/unit/client/lib/terminal-session-association.test.ts` (extend the `server-authoritative rebind (previousSessionId)` describe at :119)

**Interfaces:**
- Consumes: `SessionAssociationState` (Pick of RootState — extended with `sessions` in this task); `sessions` windows' `SessionWindowState.projects` (`sessionsSlice.ts:9-34, 156`); `CodingCliSession.title?: string` (`src/store/types.ts:96-114` zone) with the directory's own provider normalization (`provider || 'claude'`, mirroring `sessionsSlice.ts`'s `sessionKey`); `updatePaneTitle({ tabId, paneId, title, setByUser: false })` (`src/store/panesSlice.ts:1857`, re-exported :2425); the fold's existing update dispatch (`state.tabs.tabs.find` loop, :145-150 zone).
- Produces: title adoption semantics for every server-authoritative rebind (codex resume today; codex fork, opencode switch, and any future lane share the fold). No changes for first binds, conflicts, or non-matching previousSessionId.

**Why this is required:** the fold deliberately never touched titles. After a mid-life switch, a non-user-set tab keeps the superseded thread's title indefinitely (a user-set title is the user's name for the TAB and must never migrate). The title source is the session DIRECTORY row for the new key — NOT the migrated `sessionMetadataByKey` (that map is re-keyed old→new by the same fold, so reading it would adopt the OLD session's metadata).

- [ ] **Step 1: Write the failing behavioral test**

Extend the rebind describe in `test/unit/client/lib/terminal-session-association.test.ts` (the file's `createState(content, tabOverrides)` builder at :10-27 gains a `sessions` member in these cases; dispatch is the existing `vi.fn()`):

```ts
describe('rebind tab title adoption (non-user-set titles only)', () => {
  it('adopts the new session directory title for a non-user-set tab title', () => {
    // pane codex:t-1 bound to old-thread; tab 'tab-1' with title 'Old title',
    // titleSetByUser falsy/undefined; sessions windows contain a project whose
    // sessions include { provider: 'codex', sessionId: 'new-thread',
    // title: 'Durable thread title' }.
    // reconcile({ terminalId: 't-1', sessionRef: {codex,new-thread},
    //             previousSessionId: 'old-thread' })
    // Expect dispatched updateTab updates include { title: 'Durable thread
    // title' } and an updatePaneTitle dispatched with the same title and
    // setByUser: false; flushPersistedLayoutNow still fires.
  })

  it('never replaces a user-set tab title on rebind', () => {
    // same, but tab has titleSetByUser: true → neither update includes title,
    // and no updatePaneTitle title write occurs.
  })

  it('leaves the title alone when the directory has no row for the new key', () => {
    // sessions windows lack codex:new-thread → title untouched (later title
    // sources may still repaint; this fold does not invent one).
  })

  it('never adopts a title on a first bind (previousSessionId absent)', () => {
    // pane unbound + directory row present → pane/tab bind, but title stays.
  })

  it('a rebind that the conflict gate refuses never touches titles', () => {
    // previousSessionId mismatch → 'conflict', zero dispatches (existing gate;
    // pin it covers the title path too).
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-session-association.test.ts -t "rebind tab title adoption"`
Expected: FAIL — case 1 fails (no `title` in the dispatched updates: the fold never touches titles today); cases 2-5 PASS as baseline pins.

- [ ] **Step 3: Add the minimal production implementation**

`src/lib/terminal-session-association.ts`:

1. Extend the state pick:
```ts
type SessionAssociationState = Pick<RootState, 'panes' | 'tabs' | 'sessions'>
```
2. Carry the pane id through the single-pane matches (the tuple has `: Array<{ tabId: string; content: TerminalPaneContent }>` today — add `paneId`; the fill site passes `matches[0].paneId`, available from `collectMatchingTerminalPanes`).
3. Add the helper beside the others:

```ts
/**
 * The session directory's display title for the session key, if any window
 * knows one. Directory-side provider normalization mirrors sessionsSlice's
 * `sessionKey` (`provider || 'claude'`). Used ONLY for rebinds: the resumed
 * session's row still carries that thread's own title, unlike the tab's
 * migrated sessionMetadataByKey (which the fold re-keys old→new).
 */
function findSessionDirectoryTitle(
  sessions: SessionAssociationState['sessions'],
  sessionRef: SessionRef,
): string | undefined {
  for (const window of Object.values(sessions?.windows ?? {})) {
    for (const project of window?.projects ?? []) {
      for (const session of project.sessions ?? []) {
        if (
          (session.provider ?? 'claude') === sessionRef.provider
          && session.sessionId === sessionRef.sessionId
          && typeof session.title === 'string'
          && session.title.length > 0
        ) {
          return session.title
        }
      }
    }
  }
  return undefined
}
```

4. In the single-pane-tab write loop, after `durableIdentityUpdate` is computed and before the `if (Object.keys(tabUpdates).length > 0)` dispatch: per matched tab the rebind authorization predicate is evaluated against THAT pane's `content` (the loop already holds it). Extend the write block:

```ts
    const isRebindForThisTab = typeof previousSessionId === 'string'
      && previousSessionId.length > 0
      && content.sessionRef?.provider === sessionRef.provider
      && content.sessionRef?.sessionId === previousSessionId

    const tabUpdates = {
      ...(durableIdentityUpdate?.tabUpdates ?? {}),
      ...(tab.codexDurability !== nextTabCodexDurability
        ? { codexDurability: nextTabCodexDurability }
        : {}),
    }

    // Non-user-set tab titles follow a server-authoritative rebind to the
    // new session's directory title when the client already knows it.
    // User-set titles are tab-scoped and never migrate.
    let adoptedTitle: string | undefined
    if (isRebindForThisTab && !tab.titleSetByUser) {
      adoptedTitle = findSessionDirectoryTitle(state.sessions, sessionRef)
      if (adoptedTitle && adoptedTitle !== tab.title) {
        tabUpdates.title = adoptedTitle
      } else {
        adoptedTitle = undefined
      }
    }

    if (Object.keys(tabUpdates).length > 0) {
      shouldFlush = true
      dispatch(updateTab({ id: tab.id, updates: tabUpdates }))
    }
    if (adoptedTitle) {
      dispatch(updatePaneTitle({ tabId, paneId, title: adoptedTitle, setByUser: false }))
    }
```
5. Add `updatePaneTitle` to the file's panesSlice import (:2).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-session-association.test.ts -t "rebind tab title adoption"`
Expected: PASS (all five cases).

- [ ] **Step 5: Refactor while green**

The `isAuthorizedRebind` closure already encodes exactly the predicate used per tab; hoist it so the write loop calls the SAME predicate instead of duplicating the expression (one definition, two uses — the conflict gate's and the title gate's). No further cleanup.

- [ ] **Step 6: Run impacted-test verification**

Everything dispatching through this fold: association tests, the TerminalView resume flow, the App bootstrap pipeline, plus the running-state tests from Task 4 (shared surface, no behavior drift):

Run:
```bash
npm run test:vitest -- run \
  test/unit/client/lib/terminal-session-association.test.ts \
  test/unit/client/components/TerminalView.resumeSession.test.tsx \
  test/unit/client/components/App.ws-bootstrap.test.tsx \
  test/unit/client/store/sessionsSlice.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/terminal-session-association.ts \
        test/unit/client/lib/terminal-session-association.test.ts
git commit -m "feat(client): adopt the resumed session's directory title on rebind

A non-user-set tab title now follows a server-authoritative rebind to the new
session's directory title when the client already knows it; user-set titles
never migrate, and first binds are untouched. The title comes from the
session directory — NOT the migrated sessionMetadataByKey, which the same
fold re-keys old→new."
```

---

### Task 6: Pin the continuity tooling's fail-closed codex verdicts

**Files:**
- Test-only: `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` (extend — runs under the server vitest config by path rule)
- No production changes. `scripts/deploy-tab-diff.sh` is NOT modified: the kata's "unresolved coding panes must remain an explicit hard failure" already holds there (session-capable mode list hardcodes `["claude","codex","opencode","amplifier"]` at :340; `NO CAPTURED IDENTITY` verdict at :342; `RE-POINTED` at :348; non-empty diff ⇒ exit 1 at :353+; capture's coverage gate exits 4 with the `session=none`-enriched listing via `uncovered_terminals` :150-167 + `report_uncovered` :169-200 at :256-272). This task pins those guarantees for codex panes so Tasks 1-5's identity-behavior changes can never quietly route around them.

**Interfaces:**
- Consumes: the file's offline harness — `captureDoc(terms, records)` / `term` / `openRecord` / `pane` builders, `makeAbortCurl` (any network call fails the test at :86-123's pattern), `runScript(args, env)`.
- Produces: three pinned behaviors (see below) that Tasks 1-5 must keep true.

- [ ] **Step 1: Write the failing behavioral test**

Append a new describe mirroring the file's existing conventions:

```ts
describe('codex pane identity verdicts (kata 3gvd pins)', () => {
  it('verify FAILs (exit 1) a captured open codex pane with NO sessionRef as NO CAPTURED IDENTITY', async () => {
    // captureDoc: terminal term-codex (status running, mode codex, no
    // sessionRef), openRecord with a pane covering it (payload mode codex,
    // NO sessionRef). Run `verify --before doc --after doc`.
    // Expect exit 1 and output containing 'NO CAPTURED IDENTITY' and the
    // pane's ids — the unresolved coding pane NEVER passes as recoverable.
  })

  it('verify passes (exit 0) when the captured codex pane carried a sessionRef that the after doc reproduces', async () => {
    // treatment/control pair with the previous case — proves the harness
    // distinguishes true fail-closed from a vacuous pass: same shape but
    // payload.sessionRef { provider: 'codex', sessionId } present in both
    // docs ⇒ the identity-diff finds no divergence.
  })

  it('capture halts (exit 4) and lists an uncovered running codex terminal enriched with session=none', async () => {
    // captureDoc: running codex terminal present in NO record's panes.
    // `capture --out …` ⇒ exit 4; stderr listing contains the enriched row
    // form `- term-codex (mode=codex, …, session=none)` — session=none is the
    // operator-visible "never recoverable" signal.
  })
})
```

Note on red-vs-pin (honest framing): these pin EXISTING script behavior under codex fixtures. If any case fails on first run it exposes a real codex gap, and the fix lands in THIS task (minimal script change, still without touching the mode list's intent). Expected first-run: all three pass — their value is regression-pinning while Tasks 1-5 change identity behavior, plus the treatment/control pair proves non-vacuity.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- test/unit/server/deploy-tab-diff-coverage-gate.test.ts -t "codex pane identity verdicts"`
(Command-shape note, validated Stage 2 / coordinator read: for test/unit/server/** the coordinator PREPENDS `run --config <server-config>` — passing a leading `run` yourself yields a doubled positional filter; the form above produces exactly `vitest run --config <server> <path> -t "<name>"`.)
Expected: PASS as written (behavior pre-exists; see the framing note). If a real gap appears instead, Step 3 implements its minimal fix.
Also run a deliberate-mutation sanity ONCE locally (do not commit): with the codex mode temporarily struck from the script's list, the first case must exit 0-pass-to-fail transformation — confirming the pane genuinely routes through the identity verdict. Perform by hand, revert immediately, record the observation in the task notes.

- [ ] **Step 3: Add the minimal production implementation**

None — pins only. (If Step 2 surfaced a real codex gap: fix it minimally in `scripts/deploy-tab-diff.sh`, keeping the mode-list intent and the GET-only/no-network harness contract, and extend the pin set accordingly.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- test/unit/server/deploy-tab-diff-coverage-gate.test.ts`
Expected: PASS (whole file — pins plus pre-existing cases).

- [ ] **Step 5: Refactor while green**

No refactor (test-only task).

- [ ] **Step 6: Run impacted-test verification**

The change touches one test file of the server config. Neighboring continuity surfaces use the same harness helpers — run the adjacent ones to prove non-interference:

Run:
```bash
npm run test:vitest -- test/unit/server/deploy-tab-diff-coverage-gate.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/unit/server/deploy-tab-diff-coverage-gate.test.ts
git commit -m "test(freshell-server): pin fail-closed codex identity verdicts in deploy-tab-diff

Codex fixture coverage for the continuity gates the kata relies on: verify's
NO CAPTURED IDENTITY stays a hard failure for a captured codex pane with no
sessionRef; a captured-and-reproduced sessionRef verifies clean; capture's
exit-4 gate lists session=none for uncovered running codex terminals. No
production change — these pin behavior Tasks 1-5 must keep true."
```

---

## Whole-change verification (stage tail, beyond per-task gates)

Per the work contract, the full repository QA gate runs through the factory wrapper at the execution tail and again at the prospective landing commit; the three named baseline failures (`test/unit/vite-config.test.ts > getNetworkHost > …`) are the only acceptable nonzero identities. In addition to the gate, execution closes with:

1. `cargo test -p freshell-ws` and `cargo test -p freshell-codex --features real-transport` — full suites.
2. `scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/codex-resume-switch-rust.spec.ts` plus the neighboring rebind/restore codex e2e already in the repo (`opencode-rebind-rust`, `codex-terminal-restore-rust`).
3. The work-source's candidate verification `npm run check` — inspected: it is the repo's documented typecheck + coordinated full suite and is exactly the QA script's central step. It is honored as part of the gate rather than separately.

## Anti-goals (things this plan refuses)

- No terminal-output scraping, no argv-watching, no `thread/started` reliance (fixture/real divergence + the server's own opt-out list), no `~/.codex/*.sqlite` reader in production code.
- No weakening of D-03 (non-resume sources), D-FORK (disk lane owns forks), D7/A13/A8, or the S5.c gate's hold set.
- No changes to the Node server (`server/`), to `scripts/deploy-tab-diff.sh`, to `docs/index.html`, or to `.kata.toml`.
- No logs_2 corroborator tail (accepted residual — see User Request §3); no downtime-switch detection window beyond what the ledger chain + deploy-tab-diff already catch.
- No test that passes vacuously, fails for the wrong reason, or checks static copy for copies' sake; no baseline-failure repairs piggybacked on this work.
