# Codex Resume-Only Recovery Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable Codex panes never park as completed transcript or `recovery_failed`; every durable runtime failure stays on the single automatic `codex resume <sessionId>` recovery path until the session is usable again.

**Architecture:** Keep durable Codex runtime recovery server-owned inside `TerminalRegistry`, because the server owns PTYs, app-server sidecars, terminal buffers, bindings, and detached sessions. Remove `recovery_failed` as a stable protocol/UI state for Codex terminal runtimes; after a durable runtime failure, the terminal remains `recovering` and repeatedly launches a replacement worker with the same durable session id. Client changes are limited to deleting the parked failed state and migrating old persisted panes back into the normal `terminal.create` resume flow on load.

**Tech Stack:** TypeScript, NodeNext/ESM, React 18, Redux Toolkit, WebSocket protocol types with Zod, node-pty, Vitest, React Testing Library, superwstest, Playwright e2e.

---

## Chunk 1: Scope, Evidence, And File Structure

### Architectural Decision

The implementation must choose one recovery surface.

Use this surface:

1. A Codex terminal with a durable session id fails.
2. `TerminalRegistry` retires the failed PTY/app-server bundle.
3. `TerminalRegistry` stays in `recovering_durable`.
4. Each replacement attempt uses the existing `CodexLaunchFactory`.
5. The launch factory creates a new app-server sidecar and spawns the Codex CLI with the durable resume id.
6. The replacement is marked running only when readiness evidence matches the same durable session id.
7. If an attempt fails, another attempt is scheduled with capped backoff. There is no final `recovery_failed` terminal state.

Do not implement a second client-side runtime fallback that listens for `recovery_failed` and manually creates a new terminal during normal operation. That would keep two durable recovery paths alive. The client may only normalize legacy persisted `recovery_failed` panes during startup because those panes were created by older code and have no active recovery loop left.

### Findings To Preserve

- `terminal.create` already maps canonical `sessionRef` to a Codex resume id in `server/ws-handler.ts`, then `TerminalRegistry.create` spawns the Codex CLI with resume args.
- `TerminalRegistry` replacement attempts already pass `codex.durableSessionId ?? codex.originalResumeSessionId` to the launch factory and worker spawn.
- The bad state comes from `CodexRecoveryPolicy` exhausting after five attempts, `TerminalRegistry.enterCodexRecoveryFailed()`, and the client persisting `terminal.status: recovery_failed`.
- A failed owner remains `status: 'running'`, so future create requests can reuse it instead of launching a fresh resume. Removing the final failed state eliminates that reuse in new runtimes.
- Codex rollout/transcript discovery is identity evidence only. It must not be used as the runtime fallback and must not choose "latest file" as a recovery target.

### Files To Modify

- `server/coding-cli/codex-app-server/recovery-policy.ts`
  - Owns retry attempt sequencing and recovery input buffer semantics.
  - Owns `CodexRecoveryState`; remove `'recovery_failed'` from that union here.
  - Change `nextAttempt()` from bounded/exhaustible to unbounded with capped delay.
  - Remove the `ok: false, reason: 'exhausted'` result.

- `server/terminal-registry.ts`
  - Owns Codex PTY/app-server runtime lifecycle.
  - Remove `recovery_failed` handling after the state union is removed from `recovery-policy.ts`.
  - Delete `enterCodexRecoveryFailed()`.
  - Keep durable failures in `recovering_durable` and schedule another resume attempt.
  - Keep replacement launch strict about using the bound durable session id.

- `shared/ws-protocol.ts`
  - Owns the WebSocket message contract.
  - Remove `recovery_failed` from `terminal.status` and background runtime status types.

- `test/server/ws-handshake-snapshot.test.ts`
  - Owns handshake snapshot coverage for background runtime status.
  - Replace any `runtimeStatus: 'recovery_failed'` fixtures with `recovering`.

- `test/server/ws-protocol.test.ts`
  - Protocol verification target.
  - No current `recovery_failed` fixture is expected in this file; run it after the shared union change and edit only if implementation exposes a compile or schema fixture update.

- `src/store/types.ts`
  - Owns client terminal status types.
  - Remove `recovery_failed` from `TerminalStatus` and `BackgroundTerminal.runtimeStatus`.

- `src/components/TerminalView.tsx`
  - Owns mounted terminal pane lifecycle.
  - Stop handling `terminal.status: recovery_failed` as a normal pane status.
  - Keep `recovering` and `running` behavior.

- `src/lib/terminal-status-indicator.ts`
  - Remove `recovery_failed` styling branches.

- `src/components/TabSwitcher.tsx`
  - Remove `recovery_failed` label/destructive status handling.

- `src/store/persistedState.ts`
  - Normalize resumable legacy persisted terminal panes with `status: 'recovery_failed'` into `status: 'creating'`, `terminalId: undefined`, and preserved `sessionRef`.
  - Normalize non-resumable legacy Codex failed panes to `status: 'error'` with `RESTORE_UNAVAILABLE`, not a fresh Codex launch.

- `src/store/storage-migration.ts`
  - Apply the same normalization for local storage migrations.

- `src/store/tabsSlice.ts`
  - Normalize stale persisted tab statuses during hydrate.
  - Preserve Codex history opening as a terminal resume pane with `sessionRef`.

### Files To Inspect But Not Modify

- `src/store/paneTreeValidation.ts`
  - It currently accepts string statuses structurally, so migration can repair legacy data before typed code observes it.
  - Do not edit it unless implementation proves status validation was added there in parallel by another agent.

### Test Files To Modify

- `test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts`
  - Rewrite retry budget tests to assert capped unbounded retry.

- `test/unit/server/terminal-registry.codex-recovery.test.ts`
  - Rewrite tests that currently bless `recovery_failed`.
  - Add durable resume-only retry assertions.

- `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  - Remove durable `recovery_failed` status expectations.
  - Add a legacy-message guard proving unexpected `recovery_failed` status messages are ignored, not persisted.

- `test/unit/client/components/TabSwitcher.test.tsx`
  - Remove `Recovery failed` card/status expectations and keep `Recovering` coverage.

- `test/e2e/codex-session-resilience-flow.test.tsx`
  - Rewrite e2e expectations from `running -> recovering -> recovery_failed` to `running -> recovering -> running`.

- `test/integration/server/codex-session-flow.test.ts`
  - Strengthen durable recovery integration tests to assert no `recovery_failed` messages and resume-only replacement.

- `test/unit/client/store/persistedState.test.ts`
  - Add legacy `recovery_failed` migration coverage using `parsePersistedPanesRaw(raw: string)`.

- `test/unit/client/store/storage-migration.test.ts`
  - Add matching legacy `recovery_failed` migration coverage for local storage migration.

- `test/unit/client/store/tabsSlice.test.ts`
  - Add a completed Codex history-row open test proving it creates a terminal resume pane with `sessionRef`, not a transcript-only tab.

### Files Not To Touch

- Do not change FreshClaude, FreshCodex, or agent-chat runtime behavior.
- Do not introduce a new Codex session discovery fallback.
- Do not route recovery through `SessionView`.
- Do not change model-selection behavior or provider defaults.

### File-Size Mitigation

- `server/terminal-registry.ts`, `test/unit/server/terminal-registry.codex-recovery.test.ts`, `test/integration/server/codex-session-flow.test.ts`, `src/components/TerminalView.tsx`, and `test/unit/client/components/TerminalView.lifecycle.test.tsx` are already large. Keep edits surgical and do not move unrelated code.
- Prefer focused new store/migration tests over adding broad setup to large component tests.
- Do not split production files as part of this fix unless a compile-time dependency requires it; this plan is a state-machine correction, not a refactor.

### Verification Anchors

- Run all commands from `/home/user/code/freshell/.worktrees/plan-codex-resume-only-recovery` or the implementation worktree created from this plan.
- Production search: `rg -n "recovery_failed|Codex recovery failed" server shared src --glob '!src/store/persistedState.ts' --glob '!src/store/storage-migration.ts'`
- Allowed-reference search: `rg -n "recovery_failed" test src/store/persistedState.ts src/store/storage-migration.ts`; expected remaining test references are legacy input, invalid inbound-message, no-emission, or no-persistence assertions only.
- Focused tests:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts --run
npm run test:vitest -- test/server/ws-handshake-snapshot.test.ts test/server/ws-protocol.test.ts test/integration/server/codex-session-flow.test.ts --run
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts --run
```

- Typecheck: `npm run typecheck`
- Staging discipline: use explicit `git add <path...>` commands from this plan. Do not use `git add server shared src test`. The canonical changed-path list is:

```bash
git add server/coding-cli/codex-app-server/recovery-policy.ts server/terminal-registry.ts shared/ws-protocol.ts src/store/types.ts src/components/TerminalView.tsx src/lib/terminal-status-indicator.ts src/components/TabSwitcher.tsx src/store/persistedState.ts src/store/storage-migration.ts src/store/tabsSlice.ts test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-protocol.test.ts test/integration/server/codex-session-flow.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts
```

---

## Chunk 2: Red Tests

### Task 1: Make The Recovery Policy Red For Unbounded Retry

**Files:**
- Modify: `test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts`
- Later modify: `server/coding-cli/codex-app-server/recovery-policy.ts`

- [ ] **Step 1: Rewrite the bounded exhaustion test**

Replace the test that expects `{ ok: false, reason: 'exhausted' }` with this behavior:

```ts
it('keeps issuing attempts with capped delay instead of exhausting', () => {
  const policy = new CodexRecoveryPolicy({ now: () => 0 })

  expect(policy.nextAttempt()).toEqual({ attempt: 1, delayMs: 0 })
  expect(policy.nextAttempt()).toEqual({ attempt: 2, delayMs: 250 })
  expect(policy.nextAttempt()).toEqual({ attempt: 3, delayMs: 1000 })
  expect(policy.nextAttempt()).toEqual({ attempt: 4, delayMs: 2000 })
  expect(policy.nextAttempt()).toEqual({ attempt: 5, delayMs: 5000 })
  expect(policy.nextAttempt()).toEqual({ attempt: 6, delayMs: 5000 })
  expect(policy.nextAttempt()).toEqual({ attempt: 7, delayMs: 5000 })
})
```

- [ ] **Step 2: Rewrite the stable-reset test**

Preserve the reset semantics, but assert the next attempt after the stable window returns attempt 1:

```ts
it('resets the retry sequence after a stable running window', () => {
  let now = 0
  const policy = new CodexRecoveryPolicy({ now: () => now })

  for (let index = 0; index < 8; index += 1) {
    policy.nextAttempt()
  }

  policy.markStableRunning()
  now += 10 * 60 * 1000 + 1

  expect(policy.nextAttempt()).toEqual({ attempt: 1, delayMs: 0 })
})
```

Use the existing literal stable window from the current test. Do not add a new import solely for red-test scaffolding.

- [ ] **Step 3: Rewrite the ongoing-recovery time-passing test**

Replace `does not replenish attempts merely because time passes while recovery continues` with:

```ts
it('keeps capped attempts while time passes during ongoing recovery', () => {
  let now = 0
  const policy = new CodexRecoveryPolicy({ now: () => now })

  for (let index = 0; index < 5; index += 1) {
    policy.nextAttempt()
  }
  now += 2 * 60 * 1000

  expect(policy.nextAttempt()).toEqual({ attempt: 6, delayMs: 5000 })
  expect(policy.nextAttempt()).toEqual({ attempt: 7, delayMs: 5000 })
})
```

- [ ] **Step 4: Run the policy tests and verify red**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts --run
```

Expected: FAIL because the current implementation still returns `ok`-wrapped successful attempts and then returns `{ ok: false, reason: 'exhausted' }` after the fifth attempt.

- [ ] **Step 5: Commit the red policy test**

```bash
git add test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts
git commit -m "test: require unbounded codex recovery retry policy"
```

### Task 2: Make Server Recovery Red For No Final `recovery_failed`

**Files:**
- Modify: `test/unit/server/terminal-registry.codex-recovery.test.ts`
- Later modify: `server/terminal-registry.ts`

- [ ] **Step 1: Rewrite the bounded launch failure test**

Replace `enters recovery_failed after bounded replacement launch failures without emitting terminal.exit` with:

```ts
it('keeps retrying durable Codex resume after repeated replacement launch failures', async () => {
  vi.useFakeTimers()
  const exited = vi.fn()
  const status = vi.fn()
  registry.on('terminal.exit', exited)
  registry.on('terminal.status', status)
  const launchFactory = vi.fn().mockRejectedValue(new Error('replacement launch unavailable'))
  const record = registry.create({
    mode: 'codex',
    cwd: '/repo',
    resumeSessionId: 'thread-durable-1',
    codexLaunchFactory: launchFactory,
  })
  const oldPty = await lastPty()

  oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })

  for (let index = 0; index < 16; index += 1) {
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()
  }

  expect(launchFactory.mock.calls.length).toBeGreaterThan(5)
  expect(record.status).toBe('running')
  expect(record.codex?.recoveryState).toBe('recovering_durable')
  expect(exited).not.toHaveBeenCalled()
  expect(status).toHaveBeenCalledWith(expect.objectContaining({
    terminalId: record.terminalId,
    status: 'recovering',
  }))
  expect(status).not.toHaveBeenCalledWith(expect.objectContaining({
    terminalId: record.terminalId,
    status: 'recovery_failed',
  }))
  expect(launchFactory.mock.calls.every(([input]) => input.resumeSessionId === 'thread-durable-1')).toBe(true)
})
```

- [ ] **Step 2: Rewrite the exhausted-budget retire test**

Replace `retires the current failed Codex worker when retry budget is already exhausted` with a test that advances the retry policy past five attempts, triggers a failure, and asserts another replacement attempt is scheduled instead of a parked failed state:

```ts
it('retires the failed worker and schedules another durable resume attempt after many failures', async () => {
  vi.useFakeTimers()
  const sidecar = createMockSidecar()
  const status = vi.fn()
  registry.on('terminal.status', status)
  const launchFactory = vi.fn().mockRejectedValue(new Error('still unavailable'))
  const record = registry.create({
    mode: 'codex',
    cwd: '/repo',
    resumeSessionId: 'thread-durable-1',
    codexSidecar: sidecar.api,
    codexLaunchFactory: launchFactory,
  })
  const failedPty = await lastPty()

  for (let index = 0; index < 5; index += 1) {
    record.codex!.recoveryPolicy.nextAttempt()
  }

  failedPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
  await vi.runOnlyPendingTimersAsync()
  await Promise.resolve()

  expect(record.codex?.retiringGenerations.has(1)).toBe(true)
  expect(record.codex?.closeReasonByGeneration.get(1)).toBe('recovery_retire')
  expect(sidecar.api.shutdown).toHaveBeenCalledTimes(1)
  expect(failedPty.kill).toHaveBeenCalledTimes(1)
  expect(record.codex?.recoveryState).toBe('recovering_durable')
  expect(status).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'recovery_failed' }))
  expect(launchFactory).toHaveBeenCalled()
})
```

- [ ] **Step 3: Delete or rewrite the local `recovery_failed` input test**

Remove the assertion that input to `recovery_failed` is handled locally. Keep input buffering coverage for `recovering_durable`:

```ts
it('buffers input while durable Codex recovery is active', async () => {
  const record = registry.create({
    mode: 'codex',
    cwd: '/repo',
    resumeSessionId: 'thread-durable-1',
  })
  const pty = await lastPty()
  record.codex!.recoveryState = 'recovering_durable'

  expect(registry.input(record.terminalId, 'abc')).toBe(true)

  expect(pty.write).not.toHaveBeenCalledWith('abc')
})
```

- [ ] **Step 4: Rewrite idle-kill coverage**

Keep `recovering_pre_durable` and `recovering_durable` protected from idle kill. Remove the `recovery_failed` case:

```ts
const recoveringPreDurable = registry.create({ mode: 'codex', cwd: '/repo' })
recoveringPreDurable.codex!.recoveryState = 'recovering_pre_durable'
recoveringPreDurable.lastActivityAt = Date.now() - 120_000

const recoveringDurable = registry.create({
  mode: 'codex',
  cwd: '/repo',
  resumeSessionId: 'thread-durable-1',
})
recoveringDurable.codex!.recoveryState = 'recovering_durable'
recoveringDurable.lastActivityAt = Date.now() - 120_000

const shell = registry.create({ mode: 'shell', cwd: '/repo' })
shell.lastActivityAt = Date.now() - 120_000

await registry.enforceIdleKillsForTest()

expect(recoveringPreDurable.status).toBe('running')
expect(recoveringDurable.status).toBe('running')
expect(shell.status).toBe('exited')
```

- [ ] **Step 5: Run the registry recovery tests and verify red**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts --run
```

Expected: FAIL because `recovery_failed` still exists and recovery still exhausts.

- [ ] **Step 6: Commit the red registry tests**

```bash
git add test/unit/server/terminal-registry.codex-recovery.test.ts
git commit -m "test: require codex durable recovery to keep retrying resume"
```

### Task 3: Make Client Tests Red For No Parked Failed Status

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/codex-session-resilience-flow.test.tsx`
- Later modify: `src/components/TerminalView.tsx`
- Later modify: `src/store/types.ts`

- [ ] **Step 1: Add a red legacy-status guard**

In `test/unit/client/components/TerminalView.lifecycle.test.tsx`, first extend the existing local helper instead of inventing new test harness code.

Change:

```ts
function setupThemeTerminal() {
```

To:

```ts
function setupThemeTerminal(overrides: Partial<TerminalPaneContent> = {}) {
```

Then build `paneContent` with overrides and keep the tab mode/status derived from that content:

```ts
const paneContent: TerminalPaneContent = {
  kind: 'terminal',
  createRequestId: 'req-theme',
  status: 'creating',
  mode: 'claude',
  shell: 'system',
  initialCwd: '/tmp',
  ...overrides,
}
```

In the preloaded tab, use:

```ts
mode: paneContent.mode,
status: paneContent.status,
```

Add this local helper near `setupThemeTerminal()`:

```ts
function getLeafTerminalContent(
  store: ReturnType<typeof setupThemeTerminal>['store'],
  tabId: string,
): TerminalPaneContent {
  const layout = store.getState().panes.layouts[tabId]
  expect(layout.type).toBe('leaf')
  expect(layout.content.kind).toBe('terminal')
  return layout.content
}
```

Then add a focused test so an unexpected legacy `recovery_failed` status is ignored:

```ts
it('ignores legacy recovery_failed terminal.status for durable Codex panes', async () => {
  const { store, tabId, paneId, paneContent } = setupThemeTerminal({
    mode: 'codex',
    sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
  })

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>,
  )

  await waitFor(() => expect(messageHandler).not.toBeNull())

  act(() => {
    messageHandler!({
      type: 'terminal.created',
      requestId: paneContent.createRequestId,
      terminalId: 'term-theme',
      createdAt: Date.now(),
    })
    messageHandler!({
      type: 'terminal.status',
      terminalId: 'term-theme',
      status: 'running',
    })
    messageHandler!({
      type: 'terminal.status',
      terminalId: 'term-theme',
      status: 'recovery_failed',
    } as any)
  })

  const content = getLeafTerminalContent(store, tabId)
  expect(content.terminalId).toBe('term-theme')
  expect(content.status).toBe('running')
})
```

Expected before implementation: FAIL because current `TerminalView` persists `recovery_failed`.

- [ ] **Step 2: Update `TerminalView.lifecycle` recoverable status test**

Find the test around `keeps the terminal id when recoverable terminal.status messages arrive`. Remove `recovery_failed` from the recoverable statuses. The assertion should cover only `recovering` and `running`.

```ts
act(() => {
  messageHandler!({
    type: 'terminal.status',
    terminalId: 'term-status',
    status: 'recovering',
  })
})
expect(layout.content.status).toBe('recovering')

act(() => {
  messageHandler!({
    type: 'terminal.status',
    terminalId: 'term-status',
    status: 'running',
  })
})
expect(layout.content.status).toBe('running')
```

- [ ] **Step 3: Rewrite Codex resilience e2e status flow**

In `test/e2e/codex-session-resilience-flow.test.tsx`, replace the explicit `recovery_failed` assertions with a no-failure assertion:

```ts
act(() => {
  messageHandler!({
    type: 'terminal.status',
    terminalId: 'term-codex-resilience',
    status: 'recovering',
  })
  messageHandler!({
    type: 'terminal.status',
    terminalId: 'term-codex-resilience',
    status: 'running',
  })
})

expect(contentFor(store, tabId).terminalId).toBe('term-codex-resilience')
expect(contentFor(store, tabId).status).toBe('running')
```

- [ ] **Step 4: Delete the reattach-stays-failed test**

Remove `keeps server runtime status authoritative when reattach becomes ready`, because the server must not send `recovery_failed` for durable Codex recovery. If a nearby test is needed, replace it with:

```ts
it('keeps recovering status through reattach until the server reports running', async () => {
  const { store, tabId, paneId, paneContent } = createStore()

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>,
  )

  await waitFor(() => expect(messageHandler).not.toBeNull())
  await waitFor(() => expect(reconnectHandler).not.toBeNull())

  act(() => {
    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-codex-resilience',
      terminalId: 'term-codex-reattach',
      createdAt: Date.now(),
    })
    messageHandler!({
      type: 'terminal.attach.ready',
      terminalId: 'term-codex-reattach',
      attachRequestId: latestAttachRequestId('term-codex-reattach'),
      headSeq: 0,
      replayFromSeq: 0,
      replayToSeq: 0,
    })
    messageHandler!({
      type: 'terminal.status',
      terminalId: 'term-codex-reattach',
      status: 'recovering',
    })
  })

  expect(contentFor(store, tabId).status).toBe('recovering')

  act(() => {
    reconnectHandler!()
    messageHandler!({
      type: 'terminal.status',
      terminalId: 'term-codex-reattach',
      status: 'running',
    })
  })

  expect(contentFor(store, tabId).terminalId).toBe('term-codex-reattach')
  expect(contentFor(store, tabId).status).toBe('running')
})
```

- [ ] **Step 5: Run the client-focused tests and verify red**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx --run
```

Expected: FAIL because the new legacy-status guard observes the production code storing `recovery_failed`.

- [ ] **Step 6: Commit the red client tests**

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx
git commit -m "test: remove parked codex recovery status from client lifecycle"
```

### Task 4: Add Legacy State And Session-Opening Red Tests

**Files:**
- Modify: `test/unit/client/store/persistedState.test.ts`
- Modify: `test/unit/client/store/storage-migration.test.ts`
- Modify: `test/unit/client/store/tabsSlice.test.ts`
- Later modify: `src/store/persistedState.ts`
- Later modify: `src/store/storage-migration.ts`
- Later modify: `src/store/tabsSlice.ts`

- [ ] **Step 1: Add persisted legacy recovery migration test**

In `test/unit/client/store/persistedState.test.ts`, add:

```ts
it('normalizes legacy Codex recovery_failed panes to creating resume panes', () => {
  const parsed = parsePersistedPanesRaw(JSON.stringify({
    version: 1,
    layouts: {
      tab1: {
        type: 'leaf',
        id: 'pane1',
        content: {
          kind: 'terminal',
          mode: 'codex',
          createRequestId: 'req-old',
          terminalId: 'term-old',
          status: 'recovery_failed',
          sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
          restoreError: {
            code: 'RESTORE_UNAVAILABLE',
            reason: 'provider_runtime_failed',
          },
          initialCwd: '/repo',
        },
      },
    },
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
  }))

  expect(parsed).not.toBeNull()
  const content = (parsed.layouts.tab1 as any).content
  expect(content).toMatchObject({
    kind: 'terminal',
    mode: 'codex',
    status: 'creating',
    sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
    initialCwd: '/repo',
  })
  expect(content.terminalId).toBeUndefined()
  expect(content.restoreError).toBeUndefined()
})
```

Add a second persisted-state test for a legacy `recovery_failed` Codex pane with no durable identity:

```ts
it('does not create a fresh Codex pane for non-resumable legacy recovery_failed state', () => {
  const parsed = parsePersistedPanesRaw(JSON.stringify({
    version: 1,
    layouts: {
      tab1: {
        type: 'leaf',
        id: 'pane1',
        content: {
          kind: 'terminal',
          mode: 'codex',
          createRequestId: 'req-old',
          terminalId: 'term-old',
          status: 'recovery_failed',
          initialCwd: '/repo',
        },
      },
    },
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
  }))

  expect(parsed).not.toBeNull()
  const content = (parsed.layouts.tab1 as any).content
  expect(content.status).toBe('error')
  expect(content.terminalId).toBeUndefined()
  expect(content.restoreError).toEqual({
    code: 'RESTORE_UNAVAILABLE',
    reason: 'invalid_legacy_restore_target',
  })
})
```

- [ ] **Step 2: Add storage migration coverage**

In `test/unit/client/store/storage-migration.test.ts`, add the same legacy pane shape to the existing migration helper and assert the migrated content has `status: 'creating'`, no `terminalId`, no stale `restoreError`, and the same Codex `sessionRef`:

```ts
expect(content).toMatchObject({
  kind: 'terminal',
  mode: 'codex',
  status: 'creating',
  sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
  initialCwd: '/repo',
})
expect(content.terminalId).toBeUndefined()
expect(content.restoreError).toBeUndefined()
```

Also add a non-resumable legacy pane case with `mode: 'codex'`, `status: 'recovery_failed'`, and no `sessionRef` or `resumeSessionId`. Assert migration strips `terminalId`, sets `status: 'error'`, and sets `restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' }`. This avoids silently creating a fresh Codex session when no durable resume id exists:

```ts
expect(content.status).toBe('error')
expect(content.terminalId).toBeUndefined()
expect(content.restoreError).toEqual({
  code: 'RESTORE_UNAVAILABLE',
  reason: 'invalid_legacy_restore_target',
})
```

- [ ] **Step 3: Add completed Codex history open test**

In `test/unit/client/store/tabsSlice.test.ts`, add:

```ts
it('opens a completed Codex history row as a terminal resume pane, not a transcript-only tab', async () => {
  const store = createTestStore()

  await store.dispatch(openSessionTab({
    sessionId: 'thread-durable-1',
    title: 'Existing Codex session',
    cwd: '/repo',
    provider: 'codex',
    sessionType: 'codex',
  }) as any)

  const state = store.getState()
  const tab = state.tabs.tabs.find((candidate) => candidate.title === 'Existing Codex session')
  expect(tab).toBeTruthy()
  expect(tab?.codingCliSessionId).toBeUndefined()
  expect(tab?.sessionRef).toEqual({ provider: 'codex', sessionId: 'thread-durable-1' })

  const layout = state.panes.layouts[tab!.id]
  expect(layout.type).toBe('leaf')
  expect(layout.content).toMatchObject({
    kind: 'terminal',
    mode: 'codex',
    sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
    status: 'creating',
  })
})
```

Adjust only the test-store helper names to match the file's existing conventions.

- [ ] **Step 4: Run store tests and verify red**

Run:

```bash
npm run test:vitest -- test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts --run
```

Expected: The legacy migration test should FAIL until normalization exists. The history-row test may already PASS; keep it as a regression test either way.

- [ ] **Step 5: Commit the red legacy/session tests**

```bash
git add test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts
git commit -m "test: recover legacy codex failed panes through resume state"
```

### Task 5: Strengthen Integration Coverage Around Actual Resume

**Files:**
- Modify: `test/integration/server/codex-session-flow.test.ts`
- Later modify: `server/terminal-registry.ts`
- Inspect: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`

- [ ] **Step 1: Strengthen durable PTY exit recovery test**

In `recovers a durable Codex PTY exit by resuming the existing upstream thread`, add assertions:

```ts
const durableSessionId = 'thread-existing-1'
const terminalStatusMessages: any[] = []
const onMessage = (raw: any) => {
  const msg = JSON.parse(raw.toString())
  if (msg.type === 'terminal.status' || msg.type === 'terminal.exit') {
    terminalStatusMessages.push(msg)
  }
}
ws.on('message', onMessage)

// Existing test body drives terminal.create and waits for recovery/running.

expect(terminalStatusMessages.some((msg) =>
  msg.type === 'terminal.status' && msg.status === 'recovery_failed'
)).toBe(false)
expect(terminalStatusMessages.some((msg) =>
  msg.type === 'terminal.exit' && msg.terminalId === created.terminalId
)).toBe(false)

const operations = await readThreadOperations(threadOperationLogPath)
expect(operations.filter((entry) => entry.method === 'thread/resume')).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ threadId: durableSessionId }),
  ]),
)
expect(operations.filter((entry) =>
  entry.method === 'thread/resume' && entry.threadId === durableSessionId
).length).toBeGreaterThanOrEqual(2)
expect(operations.some((entry) => entry.method === 'thread/start')).toBe(false)
```

- [ ] **Step 2: Add more-than-budget launch-failure-then-success integration test**

Use the existing `planner` instance already created near the top of `test/integration/server/codex-session-flow.test.ts`. Install the spy only after the initial durable `terminal.create` has succeeded, so it fails replacement launch attempts rather than the first resume create:

```ts
const durableSessionId = 'thread-existing-1'
let planCreateSpy: ReturnType<typeof vi.spyOn> | undefined
let ws: WebSocket | undefined

try {
  process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
    appendThreadOperationLogPath: threadOperationLogPath,
    assertNoDuplicateActiveThread: true,
  })
  process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
    sleepMs: 30_000,
  })

  ws = await createAuthenticatedWs(port)
  const receivedMessages: any[] = []
  ws.on('message', (raw) => {
    receivedMessages.push(JSON.parse(raw.toString()))
  })

  // First: create the durable Codex terminal normally and wait for terminal.created.

  const originalPlanCreate = planner.planCreate.bind(planner)
  let plannedFailures = 5
  planCreateSpy = vi.spyOn(planner, 'planCreate').mockImplementation(async (input) => {
    if (input.resumeSessionId === durableSessionId && plannedFailures > 0) {
      const failureNumber = 6 - plannedFailures
      plannedFailures -= 1
      throw new Error(`planned replacement failure ${failureNumber}`)
    }
    return originalPlanCreate(input)
  })

  // Trigger failure, wait for recovery with long per-wait timeouts, and run assertions.
} finally {
  planCreateSpy?.mockRestore()
  if (ws) await closeWebSocket(ws)
  delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
  delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
}
```

The outer `try/finally` is mandatory and must include env setup, WebSocket creation/close, initial create, spy install, assertions, spy restore, and env deletion. Do not put cleanup after assertions where a thrown assertion can skip it.

Inside the `try` block, drive a durable PTY failure after installing the spy by killing the active PTY directly, not by calling `registry.kill()`:

```ts
const record = registry.get(created.terminalId)
expect(record?.codex?.durableSessionId).toBe(durableSessionId)
record?.pty.kill()
```

Do not use fake timers in this integration test because it runs real WebSocket and PTY processes. Give the test an explicit timeout and wait through the capped retry schedule until the sixth replacement succeeds:

```ts
it('keeps retrying replacement launch failures until durable resume succeeds', async () => {
  // test body
}, 25_000)
```

Use a longer per-wait timeout for the final recovery evidence, because five failed attempts require roughly 13.25 seconds of real backoff before the sixth replacement can run:

```ts
await waitForMessage(
  ws,
  (msg) => msg.type === 'terminal.status'
    && msg.terminalId === created.terminalId
    && msg.status === 'running',
  20_000,
)

await waitForCondition(async () => {
  const operations = await readThreadOperations(threadOperationLogPath).catch(() => [])
  return operations.filter((entry) => (
    entry.method === 'thread/resume'
    && entry.threadId === durableSessionId
  )).length >= 2
}, 20_000)
```

Assert:

```ts
expect(receivedMessages.some((msg) =>
  msg.type === 'terminal.status' && msg.status === 'recovery_failed'
)).toBe(false)
expect(receivedMessages).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: 'terminal.status', status: 'recovering' }),
  expect.objectContaining({ type: 'terminal.status', status: 'running' }),
]))
const operations = await readThreadOperations(threadOperationLogPath)
const resumeOperations = operations.filter((entry) =>
  entry.method === 'thread/resume' && entry.threadId === durableSessionId
)
const startOperations = operations.filter((entry) => entry.method === 'thread/start')
expect(resumeOperations.length).toBeGreaterThanOrEqual(2)
expect(resumeOperations.every((entry) => entry.threadId === durableSessionId)).toBe(true)
expect(startOperations).toHaveLength(0)
expect(planCreateSpy!.mock.calls.filter(([input]) =>
  input.resumeSessionId === durableSessionId
).length).toBeGreaterThanOrEqual(6)
```

The `try/finally` is mandatory. Do not leave `mockRestore()` after assertions where a thrown assertion can skip it.

- [ ] **Step 3: Run integration test and verify red where expected**

Run:

```bash
npm run test:vitest -- test/integration/server/codex-session-flow.test.ts --run
```

Expected: FAIL if `recovery_failed` is emitted or replacement attempts exhaust.

- [ ] **Step 4: Commit the integration test changes**

```bash
git add test/integration/server/codex-session-flow.test.ts
git commit -m "test: assert codex runtime recovery resumes existing thread"
```

### Red-Test Boundary Notes

- Protocol and TabSwitcher tests may need small red-test edits while the shared `recovery_failed` union member still exists. They are implementation-coupled contract cleanup and are handled explicitly in Tasks 8 and 10 before broad typecheck.
- Do not run a repo-wide typecheck after Chunk 2. The red tests intentionally describe a contract that production types have not adopted yet.

---

## Chunk 3: Server Implementation

### Task 6: Make `CodexRecoveryPolicy` Unbounded With Capped Backoff

**Files:**
- Modify: `server/coding-cli/codex-app-server/recovery-policy.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts`

- [ ] **Step 1: Change the attempt result type**

Replace:

```ts
export type CodexRecoveryAttemptResult =
  | { ok: true; attempt: number; delayMs: number }
  | { ok: false; reason: 'exhausted' }
```

With:

```ts
export type CodexRecoveryAttempt = { attempt: number; delayMs: number }
```

- [ ] **Step 2: Update `nextAttempt()`**

Replace the bounded method with:

```ts
nextAttempt(): CodexRecoveryAttempt {
  this.resetIfStableWindowElapsed()
  this.stableSince = undefined

  const attempt = this.attemptsUsed + 1
  const delayIndex = Math.min(this.attemptsUsed, RETRY_DELAYS_MS.length - 1)
  const delayMs = RETRY_DELAYS_MS[delayIndex]
  this.attemptsUsed = attempt
  return { attempt, delayMs }
}
```

- [ ] **Step 3: Keep exported retry constants**

Keep `CODEX_RECOVERY_RETRY_DELAYS_MS` exported so tests can assert the cap if they prefer. Do not add a new environment variable unless a test proves one is needed.

- [ ] **Step 4: Run policy tests**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-app-server/recovery-policy.ts test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts
git commit -m "fix: make codex recovery retry policy unbounded"
```

### Task 7: Remove Final `recovery_failed` From TerminalRegistry

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `server/coding-cli/codex-app-server/recovery-policy.ts`
- Test: `test/unit/server/terminal-registry.codex-recovery.test.ts`

- [ ] **Step 1: Remove the failed state from runtime types**

Change:

```ts
type TerminalRuntimeStatus = 'running' | 'recovering' | 'recovery_failed'
```

To:

```ts
type TerminalRuntimeStatus = 'running' | 'recovering'
```

Remove `'recovery_failed'` from `CodexRecoveryState`.

- [ ] **Step 2: Remove failed-state protection**

Change `isCodexRecoveryProtected()` to:

```ts
private isCodexRecoveryProtected(record: TerminalRecord): boolean {
  return this.isCodexRecoveryState(record)
}
```

- [ ] **Step 3: Remove failed-state runtime projection**

Change `getRuntimeStatus()` to:

```ts
private getRuntimeStatus(record: TerminalRecord): TerminalRuntimeStatus | undefined {
  if (record.status === 'exited') return undefined
  if (record.mode !== 'codex') return 'running'
  return this.isCodexRecoveryState(record) ? 'recovering' : 'running'
}
```

- [ ] **Step 4: Remove exhaustion handling in `startCodexBundleReplacement()`**

Replace:

```ts
const attempt = codex.recoveryPolicy.nextAttempt()
if (!attempt.ok) {
  await this.retireCodexWorkerBundle(record, retiringGeneration)
  this.enterCodexRecoveryFailed(record, source, error)
  return
}
```

With:

```ts
const attempt = codex.recoveryPolicy.nextAttempt()
```

Keep the existing `retireCodexWorkerBundle()` call after `emitTerminalStatus(record, 'recovering', ...)`.

- [ ] **Step 5: Delete `enterCodexRecoveryFailed()`**

Remove the method and all callers. No replacement method is needed because failed attempts recurse into `startCodexBundleReplacement()`.

- [ ] **Step 6: Remove failed-input behavior**

Delete:

```ts
if (term.mode === 'codex' && term.codex?.recoveryState === 'recovery_failed') {
  this.appendLocalTerminalMessage(term, CODEX_RECOVERY_FAILED_INPUT_MESSAGE)
  return true
}
```

Delete `CODEX_RECOVERY_FAILED_INPUT_MESSAGE`.

- [ ] **Step 7: Keep durable resume strict during replacement**

In `runCodexReplacementAttempt()`, keep:

```ts
const resumeSessionId = codex.durableSessionId ?? codex.originalResumeSessionId
```

Add a guard before launching:

```ts
if (codex.recoveryState === 'recovering_durable' && !resumeSessionId) {
  await this.failActiveCodexReplacementAttempt(
    record,
    attemptId,
    'replacement_launch_failure',
    new Error('Codex durable recovery cannot continue without a durable session id.'),
  )
  return
}
```

This guard should never fire for a valid durable session. It documents the invariant and prevents accidental fresh-session replacement.

- [ ] **Step 8: Preserve terminal identity fields**

Verify `TerminalRegistry.create()` still initializes all three durable identity fields for Codex resumes:

```ts
resumeSessionId: normalized
codex.durableSessionId: normalized
codex.originalResumeSessionId: normalized
```

If `record.resumeSessionId` is not set until `bindSession()`, keep that pattern. Do not add a second identity source.

- [ ] **Step 9: Run registry recovery tests**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts --run
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/terminal-registry.ts server/coding-cli/codex-app-server/recovery-policy.ts test/unit/server/terminal-registry.codex-recovery.test.ts
git commit -m "fix: keep durable codex recovery on resume retry path"
```

### Task 8: Update WebSocket And Server Snapshot Contracts

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/server/ws-protocol.test.ts`
- Test: server protocol tests.

- [ ] **Step 1: Update `TerminalStatusMessage`**

Change:

```ts
status: 'running' | 'recovering' | 'recovery_failed'
```

To:

```ts
status: 'running' | 'recovering'
```

- [ ] **Step 2: Update background runtime status type**

Change any `runtimeStatus?: 'running' | 'recovering' | 'recovery_failed'` to:

```ts
runtimeStatus?: 'running' | 'recovering'
```

- [ ] **Step 3: Rewrite handshake snapshot tests**

Remove snapshot fixtures that include `runtimeStatus: 'recovery_failed'`. Replace them with a `recovering` fixture where coverage is still useful:

```ts
expect(byId.get('term-runtime-recovering')).toMatchObject({
  terminalId: 'term-runtime-recovering',
  runtimeStatus: 'recovering',
})
```

- [ ] **Step 4: Check ws-protocol test impact**

`test/server/ws-protocol.test.ts` does not currently have a `recovery_failed` fixture. Keep it in the focused run because changing `shared/ws-protocol.ts` can expose schema or type fixture fallout. Edit this file only if the focused run fails because of the shared union removal.

- [ ] **Step 5: Run protocol tests**

Run:

```bash
npm run test:vitest -- test/server/ws-handshake-snapshot.test.ts test/server/ws-protocol.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Confirm production protocol references are gone**

Run:

```bash
rg -n "recovery_failed|Codex recovery failed" server shared
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add shared/ws-protocol.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-protocol.test.ts
git commit -m "fix: remove codex recovery_failed from websocket contract"
```

### Task 9: Strengthen Resume Command Integration

**Files:**
- Modify: `test/integration/server/codex-session-flow.test.ts`
- Inspect: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`

- [ ] **Step 1: Verify fake fixture records repeated operations**

Confirm the fixture uses append-style JSONL logging for thread operations. The expected implementation shape is:

```js
await fs.promises.appendFile(
  operationLogPath,
  `${JSON.stringify({ method, threadId })}\n`,
  'utf8',
)
```

If the fixture already has equivalent append logging, do not edit it.

- [ ] **Step 2: Assert resume-only operations**

In durable recovery tests, assert no new-thread start operation occurs for the recovered durable session:

```ts
const operations = await readThreadOperations(threadOperationLogPath)
const resumeOperations = operations.filter((entry) =>
  entry.method === 'thread/resume' && entry.threadId === durableSessionId
)
const startOperations = operations.filter((entry) => entry.method === 'thread/start')

expect(resumeOperations.length).toBeGreaterThanOrEqual(2)
expect(startOperations).toHaveLength(0)
```

For tests where the initial resume count is not fixed, capture the operation count immediately before triggering the failure and assert the count increases after recovery. Update these existing integration scenarios where they already have successful operation logging and durable recovery: app-server client disconnect recovery, provider thread closed recovery, provider notLoaded/systemError recovery, and durable PTY exit recovery. Do not apply this operation-log assertion to `restores a persisted Codex session through the exact durable CLI form`; that test intentionally forces `thread/resume` to fail, and the fake fixture only logs successful thread operations there. Keep that restore test focused on CLI arguments: `--remote`, `resume`, and the exact durable session id.

- [ ] **Step 3: Run integration coverage**

Run:

```bash
npm run test:vitest -- test/integration/server/codex-session-flow.test.ts --run
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration/server/codex-session-flow.test.ts
git commit -m "test: prove codex recovery uses durable resume command"
```

If Step 1 required a fixture edit, add `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` to this commit as well. Do not commit an unchanged fixture path.

### Server/Client Type Boundary Note

Chunk 3 may temporarily leave client TypeScript errors after `shared/ws-protocol.ts` removes `recovery_failed`. Do not run the full typecheck until Chunk 4 removes the client status union member and UI branches.

---

## Chunk 4: Client And Persistence Implementation

### Task 10: Remove `recovery_failed` From Client Runtime Types And UI

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/terminal-status-indicator.ts`
- Modify: `src/components/TabSwitcher.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/e2e/codex-session-resilience-flow.test.tsx`
- Test: `test/unit/client/components/TabSwitcher.test.tsx`

- [ ] **Step 1: Update client status types**

Change:

```ts
export type TerminalStatus = 'creating' | 'running' | 'recovering' | 'recovery_failed' | 'exited' | 'error'
```

To:

```ts
export type TerminalStatus = 'creating' | 'running' | 'recovering' | 'exited' | 'error'
```

Change background runtime status similarly.

- [ ] **Step 2: Update `TerminalView` status handler**

Replace:

```ts
if (
  msg.status === 'running'
  || msg.status === 'recovering'
  || msg.status === 'recovery_failed'
) {
```

With:

```ts
if (msg.status === 'running' || msg.status === 'recovering') {
```

Do not add runtime recreation logic here.

- [ ] **Step 3: Update status indicator styling**

Remove `case 'recovery_failed'` from both switch statements in `src/lib/terminal-status-indicator.ts`.

- [ ] **Step 4: Update TabSwitcher labels**

Remove:

```ts
case 'recovery_failed':
  return 'Recovery failed'
```

Change destructive status check to:

```ts
return status === 'exited' || status === 'error'
```

- [ ] **Step 5: Update TabSwitcher tests**

Remove the failed Codex card from tests that currently expect "Recovery failed". Keep "Recovering" coverage.

- [ ] **Step 6: Run client lifecycle tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx test/unit/client/components/TabSwitcher.test.tsx --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/types.ts src/components/TerminalView.tsx src/lib/terminal-status-indicator.ts src/components/TabSwitcher.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx test/unit/client/components/TabSwitcher.test.tsx
git commit -m "fix: remove parked recovery status from client UI"
```

### Task 11: Migrate Legacy Persisted `recovery_failed` Panes To Creating Resume State

**Files:**
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `test/unit/client/store/persistedState.test.ts`
- Modify: `test/unit/client/store/storage-migration.test.ts`
- Modify: `test/unit/client/store/tabsSlice.test.ts`

- [ ] **Step 1: Add a shared local helper in `persistedState.ts`**

Add `buildRestoreError` to the existing `@shared/session-contract` import.

Near `normalizeTerminalContent`, add:

```ts
function normalizeLegacyRecoveryFailedTerminal(
  content: Record<string, unknown>,
  durableState: { sessionRef?: unknown },
): Record<string, unknown> {
  if (content.kind !== 'terminal' || content.mode !== 'codex' || content.status !== 'recovery_failed') {
    return content
  }

  const { terminalId: _terminalId, status: _status, restoreError: _restoreError, ...rest } = content
  if (durableState.sessionRef) {
    return {
      ...rest,
      status: 'creating',
    }
  }

  return {
    ...rest,
    status: 'error',
    restoreError: buildRestoreError('invalid_legacy_restore_target'),
  }
}
```

- [ ] **Step 2: Use the helper before returning normalized terminal content**

In `normalizeTerminalContent`, after computing `durableState` and stripping legacy fields:

```ts
const isLegacyRecoveryFailed = (
  rest.kind === 'terminal'
  && rest.mode === 'codex'
  && rest.status === 'recovery_failed'
)
const normalizedRuntime = normalizeLegacyRecoveryFailedTerminal(rest, durableState)
const normalizedRestoreError = isLegacyRecoveryFailed
  ? undefined
  : durableState.restoreError ?? existingRestoreError

return {
  ...normalizedRuntime,
  ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
  ...(normalizedRestoreError
    ? { restoreError: normalizedRestoreError }
    : {}),
}
```

This prevents a stale `provider_runtime_failed` restore error from being reattached to a valid legacy Codex pane that has been converted back to `status: 'creating'`. The non-resumable case keeps the `restoreError` returned by `normalizeLegacyRecoveryFailedTerminal()`.

- [ ] **Step 3: Mirror the normalization in `storage-migration.ts`**

Apply the same transformation in `normalizeLayoutNode()` for terminal content so older local layouts are repaired during version migrations as well as persisted-state parsing. Import `buildRestoreError` there too.

- [ ] **Step 4: Normalize legacy tab statuses during hydrate**

In `src/store/tabsSlice.ts`, add a helper near `migrateTabFields()`:

```ts
function normalizePersistedTerminalStatus(status: unknown): TerminalStatus {
  if (
    status === 'running'
    || status === 'recovering'
    || status === 'exited'
    || status === 'error'
    || status === 'creating'
  ) {
    return status
  }
  return 'creating'
}
```

This intentionally maps legacy `recovery_failed` and any unknown stale value to `creating`, so a hydrated Codex history tab re-enters the normal resume path.

Replace:

```ts
status: t.status || 'creating',
```

With:

```ts
status: normalizePersistedTerminalStatus(t.status),
```

In `test/unit/client/store/tabsSlice.test.ts`, add a hydrate/remote-tabs assertion showing a tab with legacy `status: 'recovery_failed'` becomes `status: 'creating'` and keeps `sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' }`.

- [ ] **Step 5: Do not preserve stale terminal id**

The migrated pane must have `terminalId: undefined`. It must keep:

```ts
sessionRef: { provider: 'codex', sessionId: '<durable id>' }
status: 'creating'
initialCwd
createRequestId
```

Keeping the existing `createRequestId` is acceptable during initial state parsing. If a test proves duplicate request ids are reused against a live server cache, generate a new id in the reducer path instead of the storage helper.

- [ ] **Step 6: Run persisted-state and migration tests**

Run:

```bash
npm run test:vitest -- test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/persistedState.ts src/store/storage-migration.ts src/store/tabsSlice.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts
git commit -m "fix: migrate legacy codex failed panes to resume creation"
```

### Task 12: Ensure Completed Codex History Opens A Terminal Resume Pane

**Files:**
- Modify: `src/store/tabsSlice.ts` only if the red test from Task 4 fails.
- Modify: `test/unit/client/store/tabsSlice.test.ts`

- [ ] **Step 1: Run the tabsSlice history-row test**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts --run
```

Expected: PASS if existing `buildResumeContent()` and `openSessionTab()` behavior is already correct.

- [ ] **Step 2: Apply the tabsSlice fix if Step 1 fails**

If the test fails because a Codex history row creates a transcript-only tab, update `openSessionTab()` so `provider: 'codex'` and `sessionType: 'codex'` always use `buildResumeContent()` and `initLayout()` with:

```ts
{
  kind: 'terminal',
  mode: 'codex',
  sessionRef: { provider: 'codex', sessionId },
  initialCwd: cwd,
}
```

Do not set `codingCliSessionId` as the primary surface for Codex resume tabs.

- [ ] **Step 3: Run the focused tabs test**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts --run
```

Expected: PASS.

- [ ] **Step 4: Commit only if Step 2 changed files**

```bash
git add src/store/tabsSlice.ts test/unit/client/store/tabsSlice.test.ts
git commit -m "test: keep codex history opens on terminal resume surface"
```

If Step 1 passed and Step 2 made no edits, skip this commit. The regression test was already committed with Task 4.

---

## Chunk 5: Verification And Cleanup

### Task 13: Search For Remaining Parked Failure State

**Files:**
- Inspect all files.
- Modify only files where a remaining reference is production behavior or an obsolete test.

- [ ] **Step 1: Search for `recovery_failed`**

Run:

```bash
rg -n "recovery_failed" server shared src --glob '!src/store/persistedState.ts' --glob '!src/store/storage-migration.ts'
```

Expected: no production references outside `src/store/persistedState.ts` and `src/store/storage-migration.ts`.

Run the test reference search separately:

```bash
rg -n "recovery_failed" test
```

Expected: remaining test references are only intentional legacy input, invalid inbound-message, no-emission, or no-persistence assertions. Remove obsolete tests that still bless `recovery_failed` as a stable runtime state.

Validate the two allowed migration files explicitly:

```bash
rg -n "recovery_failed|Codex recovery failed" src/store/persistedState.ts src/store/storage-migration.ts
```

Expected: references are only legacy migration predicates or testable repair logic. They must not expose a stable runtime status, user-facing failed-recovery copy, or a second runtime recovery path.

- [ ] **Step 2: Search for failed recovery user copy**

Run:

```bash
rg -n "Codex recovery failed|Recovery failed|recovering failed|completed transcript" server shared src test
```

Expected: no Codex terminal runtime copy telling the user to close/refresh after recovery failure. Agent-chat restore errors may remain if unrelated.

- [ ] **Step 3: Remove obsolete imports and constants**

Remove unused constants, types, and tests exposed by the searches. Keep changes scoped to Codex terminal runtime recovery.

- [ ] **Step 4: Commit cleanup if cleanup changed files**

```bash
git add server/coding-cli/codex-app-server/recovery-policy.ts server/terminal-registry.ts shared/ws-protocol.ts src/store/types.ts src/components/TerminalView.tsx src/lib/terminal-status-indicator.ts src/components/TabSwitcher.tsx src/store/persistedState.ts src/store/storage-migration.ts src/store/tabsSlice.ts test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts test/integration/server/codex-session-flow.test.ts
git commit -m "chore: remove obsolete codex recovery failure state"
```

If Step 3 made no edits, skip this commit.

### Task 14: Focused Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run server recovery tests**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts --run
```

Expected: PASS.

- [ ] **Step 2: Run protocol and integration tests**

Run:

```bash
npm run test:vitest -- test/server/ws-handshake-snapshot.test.ts test/server/ws-protocol.test.ts test/integration/server/codex-session-flow.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Run client lifecycle and store tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts --run
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

### Task 15: Broad Verification Through Coordinator

**Files:**
- No planned source edits unless tests expose a defect.

- [ ] **Step 1: Check test coordinator status**

Run:

```bash
npm run test:status
```

Expected: Either no holder, or an active holder that should be allowed to finish.

- [ ] **Step 2: Run full suite through coordinator**

Run:

```bash
FRESHELL_TEST_SUMMARY="codex resume-only recovery" npm test
```

Expected: PASS.

- [ ] **Step 3: If a failure appears, diagnose before changing**

Use focused reruns with `npm run test:vitest -- ... --run`. Do not skip or mark tests flaky.

- [ ] **Step 4: Commit verification fixes if any**

```bash
git add server/coding-cli/codex-app-server/recovery-policy.ts server/terminal-registry.ts shared/ws-protocol.ts src/store/types.ts src/components/TerminalView.tsx src/lib/terminal-status-indicator.ts src/components/TabSwitcher.tsx src/store/persistedState.ts src/store/storage-migration.ts src/store/tabsSlice.ts test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts test/integration/server/codex-session-flow.test.ts
git commit -m "fix: stabilize codex resume-only recovery verification"
```

If no verification fixes were needed, skip this commit.

### Task 16: Final Review Checklist

**Files:**
- Inspect all changed files.

- [ ] **Step 1: Review final diff**

Run:

```bash
BASE_SHA=$(git merge-base main HEAD)
git status --short
git diff --name-only "$BASE_SHA"..HEAD
git diff --stat "$BASE_SHA"..HEAD
git diff "$BASE_SHA"..HEAD -- server/coding-cli/codex-app-server/recovery-policy.ts server/terminal-registry.ts shared/ws-protocol.ts src/store/types.ts src/components/TerminalView.tsx src/lib/terminal-status-indicator.ts src/components/TabSwitcher.tsx src/store/persistedState.ts src/store/storage-migration.ts src/store/tabsSlice.ts test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-protocol.test.ts test/integration/server/codex-session-flow.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-session-resilience-flow.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsSlice.test.ts
```

Expected: `git status --short` is empty before final approval. Diff shows one recovery path and no broad unrelated refactors.

- [ ] **Step 2: Confirm invariant by search**

Run:

```bash
rg -n "recovery_failed|Codex recovery failed" server shared src --glob '!src/store/persistedState.ts' --glob '!src/store/storage-migration.ts'
```

Expected: no output.

- [ ] **Step 3: Confirm resume command path**

Run:

```bash
rg -n "resumeSessionId|codexAppServer|resolveCodingCliCommand|planCodexLaunch" server/terminal-registry.ts server/ws-handler.ts server/coding-cli/codex-app-server
```

Expected: durable replacement and initial create both still feed the canonical session id into the existing Codex CLI spawn path.

- [ ] **Step 4: Squash or keep commits according to reviewer preference**

Keep red/green commits while iterating. Before PR, squash only if the user explicitly asks or repository practice requires it.

### Implementation Notes

- This plan intentionally does not add a UI prompt. Recovery is automatic.
- This plan intentionally does not add a transcript fallback. Transcript files are useful for rendering history and proving durable identity, not for recovering a live pane.
- This plan intentionally keeps runtime failure handling in the server. Client `terminal.create` remains the normal way to mount a pane and the startup repair path for legacy persisted state.
- This plan does not promise the external Codex CLI can always resume. It does guarantee Freshell will not stop trying by parking a durable session in a dead runtime state.
