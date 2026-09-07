# Restart Resumable Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right-click Refresh action with a safe, runtime-scoped Restart action for resumable coding-agent panes, while preventing a durable session from being opened twice in the current Freshell workspace.

**Architecture:** The browser asks the production Rust server to restart a durable provider session using an immutable runtime generation and session locator. The Rust server serializes the operation, captures the authoritative resume plan, stops the old runtime without final-close semantics, creates one provider-specific replacement itself, and broadcasts that committed replacement to every viewer. Client reducers generation-fence the event and attach every matching local pane to the server-created replacement. Separately, the UI removes duplicate-opening actions whenever the current workspace already has that provider/session open.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Rust, Axum/WebSocket, `freshell-protocol`, `freshell-ws`, `freshell-terminal`, `freshell-freshagent`, Vitest, Rust integration tests.

## Global Constraints

- The Node server is being retired; target the Rust server for all work. Do not modify Node-server implementation or add Node-server tests.
- `Restart pane` targets the selected pane’s underlying agent runtime/session. Every current viewer of that same runtime/session follows its replacement; unrelated panes and sessions remain untouched.
- Offer `Restart pane` only to resumable terminal/fresh-agent panes with provider-matching canonical durable identity. Shell/browser/editor/extension/non-resumable panes retain `Refresh pane`.
- Restart is limited to built-in providers that implement the tested Rust restart contract. Arbitrary/custom extension panes retain `Refresh pane` even when their manifest exposes resume arguments.
- The Rust restart transaction must be ordered, idempotent, generation/race fenced, recoverable on failure, and emit structured logs.
- Preflight resume eligibility before stopping a live runtime. If it cannot be resumed, leave the runtime running and return a visible failure.
- Preserve durable session identity and relevant provider routing/settings across restart; the Rust server uses existing provider-specific create/resume paths rather than duplicating CLI arguments or SDK resume behavior.
- Do not silently close duplicate or cross-client views. Normal sidebar selection focuses an existing pane. Sidebar context menus hide `Open in new tab` and `Open in this tab` for already-open sessions; `Open all sessions` opens only sessions not already open and reports when none remain.
- Add Rust protocol/integration coverage plus client unit/e2e coverage. Update `docs/index.html`.

---

### Task 1: Define the Rust restart transaction protocol and lifecycle contract

**Files:**
- Modify: `crates/freshell-protocol/src/client_messages.rs`
- Modify: `crates/freshell-protocol/src/server_messages.rs`
- Modify: `crates/freshell-protocol/tests/roundtrip.rs`
- Modify: `crates/freshell-ws/src/lib.rs`
- Modify: `shared/ws-protocol.ts`
- Modify: `shared/ws-version.ts` if this needs negotiated-version treatment
- Regenerate: `port/contract/ws-protocol.schema.json` and the generated contract inventory with `npm run contract:generate`
- Create: `crates/freshell-ws/src/restart.rs`
- Test: `crates/freshell-ws/tests/restart_protocol.rs`

**Interfaces:**
- Produces `agent.restart` with request ID, provider, durable session ID, runtime kind, live runtime identity, and expected runtime generation.
- Produces broadcast `agent.restart.started`, `agent.restart.replaced`, and `agent.restart.failed` server messages with durable locator, replacement runtime identity, and replacement generation.
- Produces a server-owned runtime descriptor `{ runtimeId, generation }` on every terminal/fresh-agent create, attach, inventory, reconciliation, and reconnect surface so clients can make a fenced request. The matrix is terminal `created`, `attach.ready`, inventory and pane-reconcile responses; and fresh-agent `created`, attach/snapshot/reconcile responses plus all runtime-addressed status, snapshot, approval, question, and stream events. Old-generation terminal output/exit and fresh-agent frames are fenced at the client.
- Keeps a client in-flight request until its terminal `replaced` or `failed` result. On reconnect after `ready`, resend the byte-identical request ID and fingerprint; the server replays its persisted terminal result and never runs the transaction twice.

- [ ] **Step 1: Write failing Rust protocol and transaction tests**

```rust
#[tokio::test]
async fn restart_preflights_before_stopping_the_selected_runtime() {
    let mut ws = running_resumable_terminal().await;
    send(&mut ws, restart("r1", "claude", "durable-1", "term-1", 7)).await;
    assert_eq!(next(&mut ws).await["type"], "agent.restart.started");
    assert_eq!(next(&mut ws).await["type"], "agent.restart.replaced");
}

#[tokio::test]
async fn unresumable_restart_fails_without_stopping_the_live_runtime() {
    let mut ws = running_terminal_with_missing_durable_artifact().await;
    send(&mut ws, restart("r1", "claude", "missing", "term-1", 7)).await;
    assert_eq!(next(&mut ws).await["type"], "agent.restart.failed");
    assert!(terminal_is_running("term-1").await);
}

#[tokio::test]
async fn runtime_generation_is_stable_across_attach_and_reconnect_and_changes_on_replacement() { /* create → attach → reconnect → restart */ }

#[tokio::test]
async fn resend_after_requester_disconnect_replays_the_stored_terminal_result() { /* same requestId/fingerprint, no second teardown */ }
```

- [ ] **Step 2: Verify red**

Run: `cargo test -p freshell-protocol --test roundtrip && cargo test -p freshell-ws --test restart_protocol`

Expected: FAIL because no restart frames or transaction exist.

- [ ] **Step 3: Implement typed, correlated protocol contracts**

```rust
pub struct AgentRestart {
    pub request_id: String,
    pub provider: String,
    pub session_id: String,
    pub kind: AgentRuntimeKind,
    pub live_id: String,
    pub expected_generation: u64,
}
```

Store the descriptor in one Rust runtime-ownership registry and return it in the matrix above. The event payload must include `requestId`, canonical provider/session, old and replacement generation, and a typed failure code. It must never identify arbitrary panes; clients match the durable runtime identity locally. Update the TypeScript wire authority, Rust discriminant inventories, and generated schema/contracts together; bump the wire version only if compatibility negotiation requires it.

- [ ] **Step 4: Verify green**

Run: `npm run contract:generate && cargo test -p freshell-protocol --test roundtrip && cargo test -p freshell-protocol --test version && cargo test -p freshell-ws --test restart_protocol`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add crates/freshell-protocol crates/freshell-ws shared/ws-protocol.ts shared/ws-version.ts port/contract && git commit -m "feat: define Rust agent restart transaction"`

### Task 2: Implement Rust provider-safe restart teardown and recovery

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs`
- Modify: `crates/freshell-ws/src/auto_resume.rs`
- Modify: `crates/freshell-terminal/src/registry.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs`
- Modify: `crates/freshell-freshagent/src/claude.rs`
- Modify: `crates/freshell-freshagent/src/codex.rs`
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs`
- Test: `crates/freshell-ws/tests/restart_protocol.rs`

**Interfaces:**
- Consumes `AgentRestart` and a provider-specific durable existence/resume preflight.
- Produces `shutdown_for_restart` completion only after old-session routes are quiescent; retains restartable durable identity while avoiding normal final-close retirement.
- Produces a persisted/replayable transaction result keyed by request ID plus canonical request fingerprint; a different payload reusing a request ID is rejected.

- [ ] **Step 1: Add failing provider-matrix tests**

```rust
#[tokio::test]
async fn terminal_restart_preserves_session_binding_and_suppresses_auto_resume() { /* fixture proves old exit cannot auto-resume */ }

#[tokio::test]
async fn fresh_agent_restart_quiesces_old_route_before_same_session_resume() { /* fixture proves old sidecar/session route is not reused */ }

#[tokio::test]
async fn duplicate_restart_request_replays_one_terminal_result() { /* one shutdown, one replacement generation */ }

#[tokio::test]
async fn concurrent_distinct_restart_requests_share_one_transaction_and_reconnect_replays_its_terminal_result() { /* two clients */ }

#[tokio::test]
async fn replacement_spawn_failure_enters_retryable_recovery_without_losing_the_durable_session() { /* injected provider failure → retry → replacement */ }

#[test]
fn restart_eligibility_matrix_accepts_only_supported_builtins_with_matching_canonical_identity() {
    // terminal Claude/Codex/OpenCode/Amplifier and fresh Claude/Kilroy/Codex/OpenCode;
    // reject mismatched provider, missing identity, unsupported built-in, and custom extension.
}
```

- [ ] **Step 2: Verify red**

Run: `cargo test -p freshell-ws --test restart_protocol`

Expected: FAIL because final-close/interrupt behavior is not restart-safe.

- [ ] **Step 3: Implement restart-specific lifecycle primitives**

```rust
trait RestartableRuntime {
    async fn preflight_resume(&self, locator: &SessionLocator) -> Result<ResumePlan, RestartError>;
    async fn shutdown_for_restart(&self, expected_generation: u64) -> Result<RetiredRuntime, RestartError>;
}
```

Keep durable locator, cwd, and provider settings in `ResumePlan`; reserve the session/runtime generation while shutdown runs; suppress expected-exit auto-resume; emit replacement only after child/session route retirement. Persist `preflighted`, `retired`, `replacement-failed`, and `replaced` transaction states. A replacement failure keeps the durable ResumePlan and a retryable transaction result, releases only the old runtime lease, and accepts an idempotent retry; it never silently starts a different session.

- [ ] **Step 4: Verify green**

Run: `cargo test -p freshell-ws --test restart_protocol && cargo test -p freshell-terminal && cargo test -p freshell-freshagent`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add crates/freshell-ws crates/freshell-terminal crates/freshell-freshagent && git commit -m "feat: restart Rust agent runtimes safely"`

### Task 3: Fold runtime replacement in all matching client panes

**Files:**
- Modify: `src/lib/ws-client.ts`
- Modify: `src/lib/pane-utils.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/freshAgentSlice.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Test: `test/unit/client/store/panesSlice.restart-runtime.test.ts`
- Test: `test/unit/client/restart-runtime-ws.test.ts`
- Test: `test/unit/client/store/freshAgentSlice.restart-runtime.test.ts`

**Interfaces:**
- Consumes the Rust `agent.restart.*` frames.
- Produces `requestAgentRestart`, generation-fenced replacement state, and an attach/rebind to the one server-created runtime for every local pane whose provider/durable session matches the replaced runtime.

- [ ] **Step 1: Write failing reducer and transport tests**

```ts
it('rebinds every local viewer to the server-created replacement and no unrelated pane', () => {
  dispatch(applyAgentRestartReplaced({ provider: 'claude', sessionId: 's1', oldGeneration: 7, generation: 8 }))
  expect(terminalIdsFor('claude', 's1')).toEqual(['replacement-1', 'replacement-1'])
  expect(contentFor('pane-other').createRequestId).toBe('unchanged')
})

it('drops stale restart events and never creates twice for a duplicate replacement event', () => {
  deliverRestartReplaced({ oldGeneration: 7, generation: 8 })
  deliverRestartReplaced({ oldGeneration: 7, generation: 8 })
  expect(createMessages()).toHaveLength(1)
})

it('clears stale fresh-agent snapshot, approval, question, and activity state before accepting the replacement generation', () => {
  dispatch(applyAgentRestartReplaced(freshCodexReplacement))
  expect(selectFreshState('codex', 's1')).toMatchObject({ generation: 8, pendingApprovals: {}, pendingQuestions: {} })
})

it('resends an in-flight restart after ready and folds the stored terminal result once', () => { /* disconnect → ready → same requestId → one replacement */ })
```

- [ ] **Step 2: Verify red**

Run: `npm run test:vitest -- run test/unit/client/store/panesSlice.restart-runtime.test.ts test/unit/client/restart-runtime-ws.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because restart frames/state do not exist.

- [ ] **Step 3: Implement durable-session matching and generation fences**

```ts
// Match only pane content whose provider/session/kind/flavor equals the broadcast locator.
// Set restart generation before replacing live identities with the server-created runtime;
// retain sessionRef, cwd, and settings. Ignore older/equal generations and stale old-runtime frames.
```

The replacement is created once by the Rust server; client panes attach/rebind only. Do not add Node backend paths. Register one central WebSocket subscription or middleware that folds each replacement exactly once into Redux before effects run: it updates every matching pane's `runtimeId` and numeric `runtimeGeneration`, then sends `terminal.attach` or `freshAgent.attach` for that replacement. The existing per-view `terminal.created` and `freshAgent.created` handlers remain request-ID scoped and must neither mint nor overwrite the replacement runtime.
Apply the same generation transition to `freshAgentSlice`: remove stale snapshot/stream/approval/question state for the old runtime and accept only replacement-generation events.

- [ ] **Step 4: Verify green**

Run: `npm run test:vitest -- run test/unit/client/store/panesSlice.restart-runtime.test.ts test/unit/client/restart-runtime-ws.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/lib/ws-client.ts src/lib/pane-utils.ts src/store/paneTypes.ts src/store/panesSlice.ts src/store/freshAgentSlice.ts src/components/TerminalView.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/store/panesSlice.restart-runtime.test.ts test/unit/client/store/freshAgentSlice.restart-runtime.test.ts test/unit/client/restart-runtime-ws.test.ts && git commit -m "feat: replace all runtime restart viewers"`

### Task 4: Present Restart pane and prevent duplicate session openings

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/lib/session-utils.ts`
- Modify: `docs/index.html`
- Test: `test/unit/client/components/context-menu/restart-pane-actions.test.ts`
- Test: `test/unit/client/components/context-menu/session-open-actions.test.ts`
- Test: `test/e2e/pane-context-menu-stability.test.tsx`

**Interfaces:**
- Consumes resumable pane eligibility and `findPaneForSession` across the current workspace.
- Produces `restartPane` context action and open-session menu actions only when no matching provider/durable session is currently open.

- [ ] **Step 1: Write failing UI tests**

```ts
it('shows Restart pane instead of Refresh pane only for a resumable agent pane', () => {
  expect(labelsFor(resumableTerminal)).toContain('Restart pane')
  expect(labelsFor(resumableFreshAgent)).toContain('Restart pane')
  expect(labelsFor(shellPane)).toContain('Refresh pane')
})

it('hides both duplicate-open actions when the session is already open anywhere', () => {
  expect(labelsFor(openSessionContext)).not.toContain('Open in new tab')
  expect(labelsFor(openSessionContext)).not.toContain('Open in this tab')
})

it('keeps Refresh pane for a custom extension even when it advertises resume arguments', () => {
  expect(labelsFor(resumableCustomExtension)).toContain('Refresh pane')
  expect(labelsFor(resumableCustomExtension)).not.toContain('Restart pane')
})

it('open all sessions opens only missing sessions and reports when every session is already open', () => {
  expect(openedSessionIds()).toEqual(['not-open'])
  expect(notice()).toMatch(/already open/i)
})
```

- [ ] **Step 2: Verify red**

Run: `npm run test:vitest -- run test/unit/client/components/context-menu/restart-pane-actions.test.ts test/unit/client/components/context-menu/session-open-actions.test.ts test/e2e/pane-context-menu-stability.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL because Refresh/open actions are unconditional.

- [ ] **Step 3: Implement menu policy and duplicate filtering**

```ts
const alreadyOpen = Boolean(findPaneForSession(state, { provider, sessionId }, localServerInstanceId))
const lifecycleItem = resumableRuntime
  ? restartPaneItem(tabId, paneId)
  : refreshPaneItem(tabId, paneId)
```

Use `alreadyOpen` consistently in sidebar-session context menus, `Open all sessions`, and action callbacks (callbacks must re-check current state). Keep normal sidebar selection’s focus-existing behavior. Document the new Restart action and duplicate-open behavior in `docs/index.html`.

- [ ] **Step 4: Verify green and lint**

Run: `npm run test:vitest -- run test/unit/client/components/context-menu/restart-pane-actions.test.ts test/unit/client/components/context-menu/session-open-actions.test.ts test/e2e/pane-context-menu-stability.test.tsx --config config/vitest/vitest.config.ts && npm run lint`

Expected: PASS with no lint errors.

- [ ] **Step 5: Commit**

Run: `git add src/components/context-menu src/components/Sidebar.tsx src/store/tabsSlice.ts src/lib/session-utils.ts docs/index.html test/unit/client/components/context-menu test/e2e/pane-context-menu-stability.test.tsx && git commit -m "feat: restart panes and prevent duplicate sessions"`

### Task 5: Verify end-to-end behavior and Rust/client compatibility

**Files:**
- Test: `crates/freshell-ws/tests/restart_protocol.rs`
- Test: `test/e2e/pane-context-menu-stability.test.tsx`
- Test: all focused restart and duplicate-session tests above

- [ ] **Step 1: Add and run a live Rust/browser smoke test**

Create: `test/e2e-browser/specs/restart-resumable-pane-rust.spec.ts`

The test must start a scratch Rust server, open two browser clients/panes on one built-in durable session, invoke `Restart pane` in one client, assert one replacement runtime/generation, both viewers attach to it, and an unrelated pane is unchanged.

Run: `cargo test -p freshell-ws --test restart_protocol && npm run test:vitest -- run test/e2e/pane-context-menu-stability.test.tsx test/unit/client/store/panesSlice.restart-runtime.test.ts test/unit/client/restart-runtime-ws.test.ts test/unit/client/components/context-menu/restart-pane-actions.test.ts test/unit/client/components/context-menu/session-open-actions.test.ts --config config/vitest/vitest.config.ts && npm run test:e2e:chromium -- test/e2e-browser/specs/restart-resumable-pane-rust.spec.ts --workers=1`

Expected: PASS.

- [ ] **Step 2: Run the coordinated project checks**

Run: `FRESHELL_TEST_SUMMARY='Rust agent restart and duplicate session prevention' npm test && npm run lint && npm run build && cargo test --workspace && npm run test:e2e:chromium -- test/e2e-browser/specs/restart-resumable-pane-rust.spec.ts --workers=1`

Expected: PASS.

- [ ] **Step 3: Inspect and commit verification corrections**

Run: `git diff --check origin/main...HEAD && git status --short && git add crates/freshell-protocol crates/freshell-ws crates/freshell-terminal crates/freshell-freshagent shared src test docs/index.html test/e2e-browser/specs/restart-resumable-pane-rust.spec.ts port/contract && git commit -m "test: verify Rust agent restart flow"`

Expected: diff check is silent; commit only if verification changed one of those scoped feature files. Never use `git add -A` in this shared worktree.

#### Final review iteration 1 — 2026-07-30

- OpenCode restart teardown now aborts the durable session through the shared
  serve manager before reporting success, fences predecessor completion, and
  aborts and joins the local turn and SSE tasks before replacement.
- Fresh-agent replacement correlation now uses one absolute 30-second deadline
  for the full receive loop; unrelated broadcasts cannot extend it.
- Red/green regression evidence:
  - `cargo test -p freshell-freshagent restart_shutdown_aborts_active_remote_turn -- --nocapture`
  - `cargo test -p freshell-ws --test restart_protocol fresh_replacement_result_uses_one_deadline -- --nocapture`
- Broader verification:
  - `cargo test -p freshell-freshagent --lib` — 327 passed.
  - `cargo test -p freshell-ws` — all unit, integration, and doc tests passed;
    one pre-existing host-gated test remained ignored as declared by the suite.
  - `cargo fmt --all -- --check` — passed after formatting.
  - `cargo clippy -p freshell-freshagent -p freshell-ws --all-targets -- -A clippy::too_many_arguments -D warnings`
    — passed. The unmodified strict command is blocked by pre-existing
    `too_many_arguments` findings in `claude.rs:1205` and `codex.rs:3365`.
- No Node commands, external provider processes, or live-port operations were
  used.

#### Final review iteration 2 — 2026-07-30

- Production restart preflight now captures and durably persists the exact
  runtime resume inputs before teardown:
  - fresh Claude flavour (`freshclaude` or `kilroy`) from the live runtime,
    plus cwd/model/effort/permission/sandbox from the durable identity record;
  - terminal cwd, shell, and provider model/permission/sandbox values stamped
    on the running PTY at creation.
- Ordinary replacement and boot recovery both consume that persisted plan.
  New transactions no longer force `freshclaude`, blank fresh-agent settings,
  or `Shell::System`; legacy terminal recovery records without the new fields
  retain the prior system-shell migration fallback.
- Retryable post-shutdown `agent.restart.failed` frames now keep the original
  serialized request in flight. The client retries the same bytes with bounded
  exponential backoff, retains the request across reconnect, and finalizes it
  only on `agent.restart.replaced` or a nonretryable failure.
- Red/green regression coverage includes Kilroy with nondefault Claude
  settings, serialized boot-style recovery, non-system terminal-shell/provider
  plan persistence, byte-identical retry, reconnect recovery, nonretryable
  finalization, and context-menu recovery feedback.
- Verification:
  - `cargo test -p freshell-ws --test restart_protocol` — 40 passed.
  - `cargo test -p freshell-terminal --lib` — 165 passed.
  - `cargo test -p freshell-freshagent --lib` — 327 passed.
  - `npm run test:vitest -- run test/unit/client/restart-runtime-ws.test.ts test/e2e/pane-context-menu-stability.test.tsx --config config/vitest/vitest.config.ts`
    — 16 passed.
  - `npm run typecheck` — passed.
  - `npm run lint` — zero errors; eight pre-existing hook warnings outside the
    changed lines.
  - `cargo fmt --all -- --check` — passed.
  - `cargo clippy -p freshell-terminal -p freshell-freshagent -p freshell-ws --all-targets -- -A clippy::too_many_arguments -D warnings`
    — passed.
- No Node backend changes, external provider processes, or live-port
  operations were used.

#### Final review iteration 4 — 2026-07-30

- Claude/Kilroy restart teardown now reaches a full quiescence barrier before
  it releases durable bindings or reports success:
  - captures the ownership-tagged sidecar/CLI tree while the sidecar is still
    the server's child;
  - uses bounded SIGTERM-to-SIGKILL escalation and PID/start-time confirmation;
  - awaits stdout-consumer cancellation and direct-child reaping;
  - fails closed, with structured diagnostics, if any barrier is unconfirmed.
- The active-turn regression proves that no predecessor event or durable write
  occurs after restart shutdown returns and that an ownership-tagged,
  SIGTERM-resistant CLI descendant is dead before the replacement lease opens.
- Distinct request IDs for the same locator and old runtime generation now join
  the completed transaction after the locator lock. The follower receives and
  durably stores a successful `agent.restart.replaced` terminal result
  correlated to its own request ID. Reconnect and coordinator-reopen replay do
  not repeat teardown.
- Red/green and focused regression evidence:
  - `cargo test -p freshell-freshagent restart_shutdown_quiesces_active_consumer_and_owned_cli_before_success -- --nocapture`
  - `cargo test -p freshell-ws --test restart_protocol concurrent_distinct_requests_for_one_old_runtime_share_the_replacement -- --nocapture`
  - `cargo test -p freshell-ws --test restart_protocol two_clients_with_distinct_requests_share_one_restart_and_reconnect_replays_follower -- --nocapture`
- Full impacted verification:
  - `cargo test -p freshell-freshagent --lib` — 328 passed.
  - `cargo test -p freshell-ws --test restart_protocol` — 44 passed.
  - `cargo fmt --all -- --check` — passed.
  - `cargo clippy -p freshell-freshagent -p freshell-ws --all-targets -- -A clippy::too_many_arguments -D warnings`
    — passed.
- Broader `cargo test -p freshell-ws` runs progressed through the changed
  restart target but did not complete because three unrelated timing fixtures
  failed on separate runs (`configured_plain_codex_restart_keeps_app_server_settings_off_cli_argv`,
  `crashing_agent_is_resumed_twice_then_settles_exited`, and
  `in_tui_fork_rebinds_the_pane_identity`). Each passed immediately when rerun
  alone; the full restart target remained 44/44 throughout.
- No Node backend changes, external provider processes, or live-port
  operations were used.

#### Final review iteration 5 — 2026-07-30

- Claude/Kilroy restart teardown now keeps the sidecar stdin alive until the
  ownership-tagged process tree has been captured, killed, and confirmed dead.
  The stdout consumer is then cancelled and joined, stdin is closed, and the
  direct child is reaped before the durable lease is released.
- The new Kilroy-flavoured regression fixture models a sidecar that exits on
  stdin EOF while leaving a tagged, SIGTERM-resistant CLI descendant alive.
  Before the fix it observed EOF before capture and failed; after the fix,
  shutdown confirms the descendant is dead before returning success and
  reopening the lease.
- Red/green and focused regression evidence:
  - Red:
    `cargo test -p freshell-freshagent restart_shutdown_keeps_stdin_open_until_owned_cli_is_captured -- --nocapture`
    — failed because the sidecar observed stdin EOF before ownership capture.
  - Green:
    `cargo test -p freshell-freshagent restart_shutdown_ -- --nocapture`
    — 6 passed, including both Claude/Kilroy ownership-barrier regressions.
- Full impacted verification:
  - `cargo test -p freshell-freshagent --lib` — 329 passed.
  - `cargo fmt --all -- --check` — passed.
  - `cargo clippy -p freshell-freshagent --all-targets -- -A clippy::too_many_arguments -D warnings`
    — passed.
- The five-iteration final-review cap is exhausted; no sixth final review was
  run.
- No Node backend changes, external provider processes, or live-port
  operations were used.
