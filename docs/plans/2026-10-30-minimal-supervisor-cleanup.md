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
- If a directly started process cannot be confirmed stopped or the temp directory still cannot be removed after bounded retries, report cleanup failure and retain the directory for diagnosis.

**Goal:** Make the supervisor lock-timeout test insensitive to machine load and keep Claude fixture cleanup bounded, direct-child-only, and diagnosable.

**Architecture:** Keep all changes in test code. Pause Tokio time in the supervisor test and include a delayed backend case to check the existing timeout against real blocking I/O. Reuse the existing exact-child stop helper and the shared fixture's existing bounded `fs.rm` retries; remove the permission harness's process-group kill and retain its fixture if the direct sidecar cannot be confirmed stopped.

**Tech Stack:** Rust, Tokio test-util, Node.js ESM, TypeScript, Vitest, pnpm.

## Global Constraints

- Work in `/home/dan/code/freshell/.worktrees/minimal-supervisor-cleanup` on `the-usual/minimal-supervisor-cleanup`, originally based on `7c3fd19511237be62485d03dda585eaf47d86eff` and now rebased onto `origin/main` at `5e6398d7b659b725b2ff969ebf863d2e2e187174`.
- Use pnpm `10.34.5` and frozen-lockfile installs. Use repo-owned test runners rather than raw Vitest or Cargo.
- Route Rust tests through `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust ...`; run process-kill test suites through `scripts/sandbox-test.sh`.
- Keep the configured cloud Vitest backend. Do not substitute a local backend if the cloud path fails.
- Keep production behavior unchanged. Preserve the existing structured cleanup log and the shared fixture's `fs.rm(..., { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })` behavior.
- Do not deploy, restart a service, or change the live server. The user has authorized pushing this feature branch, creating its PR, and merging after required checks pass.

---

### Task 1: Pause the Supervisor Test Clock During Real I/O

**Files:**
- Modify: `crates/freshell-supervisor/src/claude_source_observation.rs`

**Interfaces:**
- Give the existing fake `ReplyBackend` a `delay: Duration` field used only by the `slow-live` regression case.
- Do not change supervisor production code, timeout values, lock ownership, or authority assertions.

- [ ] **Step 1: Add a deterministic regression case**

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

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust -p freshell-supervisor --lib service::claude_source_observation::tests::provider_claude_nested_source_reply_requires_live_scope_after_private_ipc -- --exact`

Expected: Exactly one test runs and FAILs in `slow-live` because the 350 ms simulated backend I/O exceeds the unchanged 250 ms timeout. The failure must be the timeout assertion, not a compile, setup, or zero-tests result.

- [ ] **Step 3: Pause only this test's clock**

Change the test annotation to:

```rust
#[tokio::test(start_paused = true)]
```

Do not add a separate clock-holding task or wall watchdog. Keep the `slow-live` case so the focused test checks its existing timeout while the fake backend performs real blocking work.

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust -p freshell-supervisor --lib service::claude_source_observation::tests::provider_claude_nested_source_reply_requires_live_scope_after_private_ipc -- --exact`

Expected: Exactly one test runs and PASSes, including `slow-live`; all existing authority, timeout, and lifecycle assertions remain active.

- [ ] **Step 5: Refactor while green**

Keep the fake backend fields named rather than expanding its positional tuple. Confirm the change is limited to this test and that no production timeout or sleep was changed. No further refactor is needed if those boundaries hold.

- [ ] **Step 6: Run impacted-test verification**

Run: `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust -p freshell-supervisor`

Expected: PASS for all supervisor crate tests.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-supervisor/src/claude_source_observation.rs
git commit -m "test(supervisor): pause lock test clock during I/O"
```

---

### Task 2: Stop Only the Permission Harness's Direct Sidecar Child

**Files:**
- Modify: `test/support/stop-fixture-process.ts`
- Modify: `test/unit/provider-fixtures/stop-fixture-process.test.ts`
- Modify: `test/integration/providers/claude-permission-contract.mjs`
- Modify: `test/integration/providers/claude-permission-contract.test.ts`

**Interfaces:**
- Add `stopFixtureProcessThen(child, callback, options)`: await the existing bounded exact-child stop helper, then call the cleanup callback only after the child exit is confirmed. Propagate stop failures without invoking the callback.
- Load the TypeScript helper from the standalone ESM harness through the existing `tsx` development dependency.
- Keep the existing fixture removal retries and structured error event. Do not add any child discovery, process-group signaling, process tags, Job Objects, or platform-specific ownership code.

- [ ] **Step 1: Add a failing callback-order test**

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

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/provider-fixtures/stop-fixture-process.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because the scaffold invokes cleanup even though the fake child never exits after `SIGKILL`. It must reach the cleanup assertion; a setup error is not an acceptable red result.

- [ ] **Step 3: Await the direct child before invoking cleanup**

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

In the standalone ESM contract harness, import this helper from `../../support/stop-fixture-process.ts`. Change both harness `spawn` calls in `claude-permission-contract.test.ts` to launch `process.execPath` with `['--import', 'tsx', HARNESS, REPO_ROOT]`; update the usage comment in the `.mjs` file accordingly.

Remove `detached: true` and the POSIX `process.kill(-sidecar.pid, 'SIGKILL')` branch. Use one idempotent provider-close helper and this teardown structure:

```javascript
let providerClosed = false
const closeProvider = async () => {
  if (!provider || providerClosed) return
  providerClosed = true
  try {
    await provider.close()
  } catch (error) {
    const detail = String(error?.code ?? error?.message ?? error)
    failure ??= `provider close failed: ${detail}`
    log('error', 'provider.close_failed', { scenario: name, error: detail })
  }
}

try {
  await stopFixtureProcessThen(sidecar, async () => {
    await closeProvider()
    await fixture.cleanup()
  })
} catch (error) {
  const detail = String(error?.code ?? error?.message ?? error)
  const childExited = !sidecar || sidecar.exitCode !== null || sidecar.signalCode !== null
  if (!childExited) {
    failure ??= 'the sidecar did not exit; its fixture was retained'
    log('error', 'sidecar.stop_failed', { scenario: name, error: detail })
  } else {
    failure ??= `fixture cleanup failed: ${detail}`
    log('error', 'fixture.cleanup_failed', { scenario: name, error: detail })
  }
} finally {
  await closeProvider()
}
```

The callback must remain uncalled when `stopFixtureProcessThen` rejects, leaving the fixture root in place. A cleanup rejection after child exit remains a structured error and sets the scenario failure in the returned receipt.

Because the ESM harness now imports a TypeScript helper, add `--import tsx` to both Node invocations in `claude-permission-contract.test.ts` and update the harness usage comment to `node --import tsx claude-permission-contract.mjs <repoRoot>`.

- [ ] **Step 4: Run the focused direct-child tests**

Run: `pnpm run test:vitest run test/unit/provider-fixtures/stop-fixture-process.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS for graceful exit, escalation, timeout, and callback ordering. The child-stop helper still signals only the captured process handle.

- [ ] **Step 5: Refactor while green**

Ensure the provider close is attempted exactly once, including when direct-child stopping fails. Ensure the fixture cleanup callback is not invoked on an unconfirmed child exit. Preserve bounded `fs.rm` retries and make persistent cleanup errors visible in both structured stderr and the returned receipt. Do not add descendant tracking.

- [ ] **Step 6: Run impacted-test verification**

Run the process-kill integration test inside the disposable sandbox, preserving the configured cloud backend:

```bash
GCLOUD_ROBOT_REQUIRE=1 scripts/sandbox-test.sh "pnpm run test:vitest run test/integration/providers/claude-permission-contract.test.ts test/unit/provider-fixtures/stop-fixture-process.test.ts --config config/vitest/vitest.config.ts"
```

Expected: PASS. The actual pinned CLI contract returns one receipt line, all eight scenarios exit cleanly, and their fixtures are removed. The helper test proves that a child which does not exit is reported and its fixture cleanup callback is withheld.

- [ ] **Step 7: Commit the task**

```bash
git add test/support/stop-fixture-process.ts test/unit/provider-fixtures/stop-fixture-process.test.ts test/integration/providers/claude-permission-contract.mjs test/integration/providers/claude-permission-contract.test.ts
git commit -m "test(claude): await direct sidecar exit before cleanup"
```

---

## Final verification

After both tasks and their independent task reviews are complete, run the configured broad suite once at final `HEAD`:

```bash
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test
```

Expected: PASS across the configured client, Rust, and Electron suites. Record any runner scope not reached and investigate every non-baseline failure. Do not change the configured cloud backend to local as a fallback.

No user-facing documentation or production deployment change is needed: the delivered changes affect only test timing and test harness teardown.
