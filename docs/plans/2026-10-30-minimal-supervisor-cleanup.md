# Minimal Supervisor and Permission Harness Cleanup Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Apply the smallest reliable fixes for the flaky supervisor lock timeout (`arnn`) and Claude permission-contract harness cleanup race (`bczx`): pause Tokio test time while checking the lock timeout; for the harness, stop and await only the child processes it directly starts, then retry temporary-directory removal a few times and report any cleanup failure. Run a properly scoped Fresh Eyes review of the complete branch delta using Claude and report its result. Land the work on main through a PR after required checks pass.

### Explicit constraints
- Use the “usual” workflow, including an isolated worktree, focused tests, and independent review.
- Keep fixture cleanup limited to direct child processes; do not add cross-platform descendant or process-tree tracking.
- Use Claude for the requested Fresh Eyes review.
- Push the feature branch and create its PR; merge only after required checks pass.

### Accepted tradeoffs and residuals
- If the directly started sidecar cannot complete a clean shutdown or the temp directory still cannot be removed after bounded retries, report cleanup failure and retain the fixture for diagnosis. Never inspect or signal its CLI child.
- If the sidecar is force-killed, its native CLI may remain orphaned and could still write into the retained fixture. This follows the direct-child-only boundary; the harness does not inspect or signal the CLI.

**Goal:** Make the supervisor lock-timeout test insensitive to machine load and keep Claude fixture cleanup bounded, direct-child-only, and diagnosable.

**Architecture:** Keep all changes in test code. Pause Tokio time in the supervisor test and include a delayed backend case to check the existing timeout against real blocking I/O. Reuse the existing exact-child stop helper and the shared fixture's existing bounded `fs.rm` retries. The harness waits only for its directly spawned sidecar; it removes the fixture only after the sidecar reports clean shutdown, otherwise retaining it without signaling descendants.

**Tech Stack:** Rust, Tokio test-util, Node.js ESM, TypeScript, Vitest, pnpm.

## Global Constraints

- Work in `/home/dan/code/freshell/.worktrees/minimal-supervisor-cleanup` on `the-usual/minimal-supervisor-cleanup`, rebased onto `origin/main` at `222d1f225`.
- Use pnpm `10.34.5` and frozen-lockfile installs. Use repo-owned test runners rather than raw Vitest or Cargo.
- Route Rust tests through `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust ...`; run process-kill test suites through `scripts/sandbox-test.sh`.
- Keep the configured cloud Vitest backend. Do not substitute a local backend if the cloud path fails.
- Keep production behavior unchanged. Preserve the shared fixture's `fs.rm(..., { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })` behavior, and include persistent cleanup failures in both the receipt and structured logs.
- Do not deploy, restart a service, or change the live server. The user has authorized pushing this feature branch, creating its PR, and merging after required checks pass.

---

### Task 1: Pause the Supervisor Test Clock During Real I/O

**Files:**
- Modify: `crates/freshell-supervisor/src/claude_source_observation.rs`

**Interfaces:**
- Give the existing fake `ReplyBackend` a `delay: Duration` field used only by the `slow-live` regression case.
- Do not change supervisor production code, timeout values, lock ownership, or authority assertions.

- [x] **Step 1: Add a deterministic regression case**

Refactor the tuple-shaped fake backend to named fields and add its test delay:

```rust
struct ReplyBackend {
    before_reply: StdMutex<Option<Box<dyn FnOnce() + Send>>>,
    expected_source: StdMutex<Option<ClaudeRecoverySourceBinding>>,
    calls: std::sync::atomic::AtomicUsize,
    until: StdMutex<Option<Instant>>,
    delay: Duration,
}
```

Replace tuple-field reads with `before_reply`, `expected_source`, `calls`, and `until`. In `observe_claude_sources`, after recording the deadline, add:

```rust
if !self.delay.is_zero() {
    let delay = self.delay;
    tokio::task::spawn_blocking(move || std::thread::sleep(delay))
        .await
        .unwrap();
}
```

Add the `slow-live` mode to the existing mode list. Construct its backend with `delay: if mode == "slow-live" { Duration::from_millis(350) } else { Duration::ZERO }`. Include `slow-live` among the modes expected to return `Ok`. Keep the test's existing 250 ms timeout and leave its Tokio test annotation unpaused for this red run.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust -p freshell-supervisor --lib service::claude_source_observation::tests::provider_claude_nested_source_reply_requires_live_scope_after_private_ipc -- --exact`

Expected: Exactly one test runs and FAILs in `slow-live` because the 350 ms simulated backend I/O exceeds the unchanged 250 ms timeout. The failure must be the timeout assertion, not a compile, setup, or zero-tests result.

- [x] **Step 3: Pause only this test's clock**

Change the test annotation to:

```rust
#[tokio::test(start_paused = true)]
```

Do not add a separate clock-holding task or wall watchdog. Keep the `slow-live` case so the focused test checks its existing timeout while the fake backend performs real blocking work.

- [x] **Step 4: Run the focused test**

Run: `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust -p freshell-supervisor --lib service::claude_source_observation::tests::provider_claude_nested_source_reply_requires_live_scope_after_private_ipc -- --exact`

Expected: Exactly one test runs and PASSes, including `slow-live`; all existing authority, timeout, and lifecycle assertions remain active.

- [x] **Step 5: Refactor while green**

Keep the fake backend fields named rather than expanding its positional tuple. Confirm the change is limited to this test and that no production timeout or sleep was changed. No further refactor is needed if those boundaries hold.

- [x] **Step 6: Run impacted-test verification**

Run: `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust -p freshell-supervisor`. The repository runner builds `freshell-server` first, then invokes `cargo test --workspace` with the forwarded selector. Because `--workspace` still builds unrelated workspace packages, treat this as a workspace Rust run, not as a narrowed supervisor-only check.

Expected: PASS for all workspace Rust tests, including the supervisor crate tests.

- [x] **Step 7: Commit the task**

```bash
git add crates/freshell-supervisor/src/claude_source_observation.rs
git commit -m "test(supervisor): stabilize lock timeout with paused time" \
  -m "Pause Tokio time while the lock regression performs delayed real I/O. Keep the existing timeout and production locking behavior unchanged."
```

---

### Task 2: Stop Only the Permission Harness's Direct Sidecar Before Fixture Cleanup

**Files:**
- Modify: `test/support/stop-fixture-process.ts`
- Modify: `test/unit/provider-fixtures/stop-fixture-process.test.ts`
- Modify: `test/integration/providers/claude-permission-contract.mjs`
- Modify: `test/integration/providers/claude-permission-contract.test.ts`

**Interfaces:**
- Add `stopFixtureProcessThen(child, callback, options)`: await the existing bounded exact-child stop helper, then call the cleanup callback only after the child exit is confirmed. Propagate stop failures without invoking the callback.
- Register the directly spawned sidecar so fixture cleanup waits for its stdio `close`. Require a clean sidecar exit before removing the fixture; never inspect or signal the native CLI child.
- Keep the existing fixture removal retries. Isolate cleanup sabotage to a unique per-test fixture prefix. Do not add child discovery, process-group signaling, process tags, Job Objects, or platform-specific ownership code.

- [x] **Step 1: Add failing callback-order and cleanup-error tests**

Extend the import in `stop-fixture-process.test.ts` to include `stopFixtureProcessThen`. Add a fake child that ignores both signals and a cleanup spy. For this red run, add the following minimal scaffold to `stop-fixture-process.ts`; it deliberately invokes the callback before awaiting the stop helper so the test reaches its behavioral assertions:

```typescript
export async function stopFixtureProcessThen(
  child: FixtureProcess | undefined,
  callback: () => Promise<void>,
  options: StopFixtureProcessOptions = {},
): Promise<void> {
  await callback()
  await stopFixtureProcess(child, options)
}
```

The test is:

```typescript
it('does not run fixture cleanup when the captured child never confirms exit', async () => {
  vi.useFakeTimers()
  const child = new FakeFixtureProcess()
  const cleanup = vi.fn(async () => {})
  const stopping = stopFixtureProcessThen(child, cleanup, {
    gracefulTimeoutMs: 50,
    forceTimeoutMs: 50,
  })
  const rejected = expect(stopping).rejects.toThrow(/did not exit/i)
  await vi.advanceTimersByTimeAsync(50)
  await vi.advanceTimersByTimeAsync(50)
  await rejected
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(cleanup).not.toHaveBeenCalled()
  expect(child.listenerCount('exit')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
```

- [x] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/provider-fixtures/stop-fixture-process.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because the scaffold invokes cleanup even though the fake child never exits after `SIGKILL`. It must reach the cleanup assertion; a setup error is not an acceptable red result.

- [x] **Step 3: Await the directly spawned sidecar before invoking cleanup**

Implement the helper as a direct sequence, allowing the existing exact-child helper to reject on a refused signal or unconfirmed exit:

```typescript
export async function stopFixtureProcessThen(
  child: FixtureProcess | undefined,
  callback: () => Promise<void>,
  options: StopFixtureProcessOptions = {},
): Promise<void> {
  await stopFixtureProcess(child, options)
  await callback()
}
```

In the standalone ESM contract harness, import the helper through its `.js` specifier, and run the harness with the existing `tsx` preload. Register the sidecar with `fixture.ownProcess(sidecar)` immediately after spawn so fixture removal also waits for its stdio `close`.

Remove `detached: true` and the POSIX `process.kill(-sidecar.pid, 'SIGKILL')` branch. After the exact-child stop helper returns, close the provider and remove the fixture only when the directly spawned sidecar exited with code 0. If stop fails or the sidecar was force-killed/exited uncleanly, retain the fixture and report the reason; do not inspect, signal, or await the native CLI PID. Track whether cleanup started so stop errors cannot be mislabelled as filesystem errors. Preserve nested `AggregateError` messages and filesystem path details in logs. Use a separate `cleanupFailure` receipt field so scenario failures cannot hide cleanup failures.

The callback must remain uncalled when `stopFixtureProcessThen` rejects, leaving the fixture root in place. A filesystem cleanup rejection after clean sidecar exit remains a structured `fixture.cleanup_failed` event and sets `cleanupFailure` in the returned receipt. The cleanup-sabotage test uses a unique prefix and verifies that a similarly named stale fixture is untouched; it asserts cleanup failures in the receipt and structured events without requiring the scenario's functional `failure` field to be empty.

- [x] **Step 4: Run the focused direct-child tests**

Run: `pnpm run test:vitest run test/unit/provider-fixtures/stop-fixture-process.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS for graceful exit, escalation, timeout, and callback ordering. The child-stop helper still signals only the captured process handle.

- [x] **Step 5: Refactor while green**

Ensure the provider close is attempted exactly once, including when direct-child stopping fails. Ensure the fixture cleanup callback is not invoked on an unconfirmed child exit. Preserve bounded `fs.rm` retries and make persistent cleanup errors visible in both structured stderr and the returned receipt. Do not add descendant tracking.

- [x] **Step 6: Run impacted-test verification**

Run the process-kill integration test inside the disposable sandbox. This focused test runs locally in the sandbox; the configured cloud backend is used separately by the broad check:

```bash
GCLOUD_ROBOT_REQUIRE=1 scripts/sandbox-test.sh "pnpm run test:vitest run test/integration/providers/claude-permission-contract.test.ts test/unit/provider-fixtures/stop-fixture-process.test.ts --config config/vitest/vitest.config.ts"
```

Expected: PASS. The pinned CLI contract returns one receipt line, all eight normal scenarios exit cleanly, and their fixtures are removed. The cleanup-sabotage case reports all eight failures without modifying stale or parallel fixtures. The unclean-exit case retains its fixture and reports the status in both receipt and JSONL. Helper tests prove that cleanup waits for child exit and propagates cleanup errors. Final focused result: PASS, 2 files and 17 tests.

- [x] **Step 7: Commit the task**

```bash
git add test/support/stop-fixture-process.ts test/unit/provider-fixtures/stop-fixture-process.test.ts test/integration/providers/claude-permission-contract.mjs test/integration/providers/claude-permission-contract.test.ts
git add docs/plans/2026-10-30-minimal-supervisor-cleanup.md
git commit -m "test(claude): retain fixtures after unclean sidecar shutdown" \
  -m "Wait for the exact sidecar child and remove fixtures only after clean sidecar shutdown. Keep the fixture on stop or cleanup failure, with JSON receipt and structured diagnostics. Isolate cleanup sabotage to its own fixture prefix."
```

---

## Post-review follow-up

Claude Fresh Eyes identified that the cleanup-failure test did not prove the receipt included a cleanup reason, and that scenario failure could mask cleanup failure. The follow-up adds a separate `cleanupFailure` receipt field, structured-log assertions, nested filesystem diagnostics, helper ordering/error tests, and a unique sabotage prefix. A later review caught that waiting for the native CLI PID violated the direct-child-only constraint. That PID tracking and process-group signaling were removed; the harness now retains the fixture unless its directly spawned sidecar exits cleanly. The third and final Fresh Eyes review found that this unclean-exit retention path lacked a regression test. A test-only environment hook now changes the reported status only after the real sidecar has exited cleanly, allowing the test to verify the retained fixture and diagnostic receipt without leaving a live native CLI writer. The focused suite passed with this test included. The three-review limit has been reached, so no additional Fresh Eyes pass was run.

## Final verification

The configured broad check was run on the pre-follow-up branch head with:

```bash
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_TEST_SUMMARY='PR gate: minimal supervisor cleanup' pnpm run check
```

It failed on two unrelated suites: `runtime-build-preflight.test.ts` had a nested Node/Vitest process exceed its hard-coded 30-second timeout, and `managed-provider-parity.test.ts` timed out replaying managed output for OpenCode. The broad check has not been rerun after the follow-up changes; required PR checks remain the final integration gate. Do not change the configured cloud backend to local as a fallback.

After the final review fixes, the repository Rust runner completed `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust -p freshell-supervisor` successfully. Its wrapper ran `cargo test --workspace --locked -p freshell-supervisor`; all workspace Rust tests passed, including all 221 supervisor library tests, with existing ignored-test annotations honored.

No user-facing documentation or production deployment change is needed: the delivered changes affect only test timing and test harness teardown.
