# Freshcodex Bounce And Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop completed freshcodex panes from polling forever after a missed idle event, and stop terminal-mode Codex durable recovery from retrying failed `codex resume` candidates forever.

**Architecture:** Treat freshcodex REST snapshot status as authoritative enough to reconcile the global fresh-agent session status when no unresolved local send would make an idle snapshot stale. Keep reconciliation status-only and scoped to `freshcodex`/`codex` so the fix does not replace provider history, pending approvals, token totals, or other snapshot-derived state. Treat terminal Codex durable recovery as retryable only for a bounded number of consecutive candidate failures, then reuse the existing blocked-recovery path so the terminal closes or finalizes consistently.

**Tech Stack:** React 18, Redux Toolkit, Vitest, Testing Library, Node.js/TypeScript, NodeNext/ESM.

## Global Constraints

- Work in `/home/dan/code/freshell/.worktrees/fix-freshcodex-bounce-recovery` on branch `fix/freshcodex-bounce-recovery`.
- Server uses NodeNext/ESM; relative imports must include `.js` extensions.
- Preserve unrelated worktree changes from other agents.
- Do not restart the self-hosted Freshell production server without explicit user approval containing the word `APPROVED`.
- Use Red-Green-Refactor TDD for behavior changes.
- Do not skip tests, reduce coverage, or weaken assertions to pass.
- Prefer e2e/smoke and integration coverage where practical; focused unit tests are acceptable for isolated recovery/state logic.
- Code that is part of the repo should log robustly and use structured logs with severity.
- End-user documentation changes are not required for this bug fix because no user-facing feature or workflow is added.

---

## File Structure

- Modify `src/store/freshAgentTypes.ts`: add a monotonic per-session status freshness field.
- Modify `src/store/freshAgentSlice.ts`: advance the status freshness field on every status-affecting reducer, including same-value status updates.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`: reconcile accepted freshcodex REST snapshot statuses into `freshAgentSlice` so fallback polling can clear stale busy status without replacing full snapshot state.
- Modify `test/unit/client/store/freshAgentSlice.test.ts`: regression tests for same-value status updates advancing the freshness guard.
- Modify `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`: regression tests for stale `running` global freshcodex state corrected by an idle REST snapshot, same-value running updates blocking stale REST idle, and same-session unresolved local echo blocking idle reconciliation.
- Modify `server/terminal-registry.ts`: add bounded consecutive failure tracking for Codex durable recovery candidates.
- Modify `test/unit/server/terminal-registry.codex-sidecar.test.ts`: regression tests for the bounded recovery loop.

## Task 1: Reconcile REST Fresh-Agent Snapshots Into Global Session State

**Files:**
- Modify: `src/store/freshAgentTypes.ts`
- Modify: `src/store/freshAgentSlice.ts`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `test/unit/client/store/freshAgentSlice.test.ts`
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: `getFreshAgentThreadSnapshot(sessionType, provider, threadId, query)` returns `FreshAgentSnapshot`.
- Consumes: `setSessionStatus({ sessionId, sessionType, provider, status })` from `src/store/freshAgentSlice.ts`.
- Consumes: `collectPaneEntries(layout)` from `src/lib/pane-utils.ts`.
- Produces: `FreshAgentSessionState.statusVersion`, a monotonic in-memory status freshness counter that increments on every reducer-driven status write, including same-value writes.
- Produces: an accepted freshcodex REST snapshot updates only `freshAgent.sessions[makeFreshAgentSessionKey(...)]status` unless any same-session pane present in `state.panes.layouts` has unresolved local echo that makes an idle snapshot unsafe to apply, or the global session status version changed while the REST request was in flight.

- [x] **Step 1: Write the failing status-version reducer tests**

In `test/unit/client/store/freshAgentSlice.test.ts`, add focused reducer tests proving:

- `setSessionStatus({ status: 'running' })` creates or updates `statusVersion`.
- A second same-value `setSessionStatus({ status: 'running' })` increments `statusVersion` again.
- `freshAgentSnapshotReceived` and any other reducer in `src/store/freshAgentSlice.ts` that writes a new status event to `session.status` also advances `statusVersion`. Session identity materialization should preserve the existing version unless it intentionally emits a new status event.

These tests are intentionally not string-copy tests. They protect the ordering contract used by `FreshAgentView`: a status event with the same string value must still be observable as newer than an older REST request.

- [x] **Step 2: Write the failing component regression tests**

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, add these tests near the existing snapshot refresh tests. Wrap external store dispatches that must trigger React re-renders, and deferred snapshot resolution, in `act(...)` using the local test-file pattern. Do not rely on unwrapped `store.dispatch(...)` to update `agentSessionStatusVersionRef.current` before the REST promise continuation runs.

```tsx
  it('clears stale running session state when a freshcodex REST snapshot reports idle', async () => {
    const store = createStore()
    const sessionId = '019efd2e-3270-71d0-a3c9-e097537be604'
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 123,
      latestTurnId: null,
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
      pendingApprovals: [],
      pendingQuestions: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        sessionRef: { provider: 'codex', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-freshcodex-stale-running',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      status: 'running',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]?.status).toBe('idle')
    })
    expect(getFreshAgentPaneContent(store).status).toBe('idle')
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
      'freshcodex',
      'codex',
      sessionId,
      expect.objectContaining({ cwd: '/home/dan/code/freshell' }),
    )

    // Do not leave this as a real 3.5s sleep. Use the suite's fake-timer
    // pattern for the poll-stop assertion, or omit this assertion if fake
    // timers conflict with the component harness; global status becoming idle
    // is the behavior that stops the fallback polling path.
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not clear running session state from an idle snapshot while another pane for the same session has unresolved local echo', async () => {
    const store = createStore()
    const sessionId = '019efd2e-3270-71d0-a3c9-e097537be604'
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 124,
      latestTurnId: null,
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
      pendingApprovals: [],
      pendingQuestions: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        sessionRef: { provider: 'codex', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-freshcodex-current',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(initLayout({
      tabId: 'tab-2',
      paneId: 'pane-2',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        sessionRef: { provider: 'codex', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-freshcodex-sibling',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
        pendingLocalEcho: {
          requestId: 'req-local-send',
          text: 'still sending',
        },
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      status: 'running',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(getFreshAgentPaneContent(store).status).toBe('idle')
    })
    expect(store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]?.status).toBe('running')
  })

  it('does not let an older idle REST response overwrite a newer same-valued running session status', async () => {
    const store = createStore()
    const sessionId = 'thread-rest-race'
    const snapshot = createDeferred<Record<string, unknown>>()
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(snapshot.promise)
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        sessionRef: { provider: 'codex', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-rest-race',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      status: 'running',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    })
    const versionAtRequest = store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]?.statusVersion
    await act(async () => {
      store.dispatch(setSessionStatus({
        sessionId,
        sessionType: 'freshcodex',
        provider: 'codex',
        status: 'running',
      }))
    })
    expect(store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]?.statusVersion).toBeGreaterThan(versionAtRequest ?? -1)
    await act(async () => {
      snapshot.resolve({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: sessionId,
        sessionId,
        status: 'idle',
        revision: 125,
        latestTurnId: null,
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
        pendingApprovals: [],
        pendingQuestions: [],
      })
    })

    await waitFor(() => {
      expect(getFreshAgentPaneContent(store).status).toBe('idle')
    })
    expect(store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]?.status).toBe('running')
  })
```

- [x] **Step 3: Run the focused tests to verify RED**

Run:

```bash
npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "freshcodex REST snapshot|same-valued running session status|unresolved local echo"
```

Expected: FAIL because the slice has no `statusVersion`, and because the pane content becomes idle but `freshAgent.sessions[freshcodex:codex:<sessionId>].status` remains `running`, so the 3-second fallback poll keeps firing.

- [x] **Step 4: Add status freshness tracking**

In `src/store/freshAgentTypes.ts`, add:

```ts
  statusVersion?: number
```

to `FreshAgentSessionState`.

In `src/store/freshAgentSlice.ts`, initialize sessions with `statusVersion: 0` and add a helper near `createSession`:

```ts
function writeSessionStatus(session: FreshAgentSessionState, status: FreshAgentSessionStatus): void {
  session.status = status
  session.statusVersion = (session.statusVersion ?? 0) + 1
}
```

Replace every reducer status-event assignment to `session.status` or `state.sessions[key].status` with `writeSessionStatus(...)`. This must include same-value assignments, because a same-value `running` status from WebSocket is still a newer server-side event for the REST stale-response guard. Keep initial `createSession(...)` status assignment as initialization, not as a status event.

For `materializeSession`, which builds a migrated session through object spread rather than a direct `session.status = ...` assignment, preserve the existing `statusVersion` when it is only moving the session identity. If that reducer intentionally changes the status in the same operation, call `writeSessionStatus(...)` after creating the migrated session and cover that behavior in the reducer test.

Do not persist the version outside Redux state or derive it from wall clock time. This guard is an in-memory ordering token for races within one client runtime.
If existing reducer tests deep-equal full session objects, update the expected object to include `statusVersion` rather than weakening the assertion. Do not delete coverage to accommodate the new field.

- [x] **Step 5: Implement the reconciliation**

In `src/components/fresh-agent/FreshAgentView.tsx`, change the fresh-agent slice import:

```ts
import { clearPendingCreateFailure, setSessionStatus } from '@/store/freshAgentSlice'
```

Change the pane utility import:

```ts
import { collectPaneEntries, paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
```

Add a selector near the other `useAppSelector` calls:

```ts
  const hasUnresolvedLocalEchoForSession = useAppSelector((state) => {
    if (!paneContent.sessionId) return false
    return Object.values(state.panes.layouts).some((layout) => {
      if (!layout) return false
      return collectPaneEntries(layout).some(({ content }) => (
        content.kind === 'fresh-agent'
        && content.provider === paneContent.provider
        && content.sessionType === paneContent.sessionType
        && content.sessionId === paneContent.sessionId
        && !!content.pendingLocalEcho
      ))
    })
  })
  const hasUnresolvedLocalEchoForSessionRef = useRef(false)
  hasUnresolvedLocalEchoForSessionRef.current = hasUnresolvedLocalEchoForSession
```

Track the latest global fresh-agent session status in a ref:

```ts
  const agentSessionStatusRef = useRef(agentSession?.status)
  agentSessionStatusRef.current = agentSession?.status
  const agentSessionStatusVersionRef = useRef(agentSession?.statusVersion ?? 0)
  agentSessionStatusVersionRef.current = agentSession?.statusVersion ?? 0
```

Inside the successful `getFreshAgentThreadSnapshot(...).then((next) => { ... })` block, after `landedEcho` and `staleEcho` are computed and before returning from the status/session-id no-op branch, reconcile the live status only for freshcodex/codex and only when it is safe:

```ts
const requestAgentSessionStatusVersion = agentSessionStatusVersionRef.current
```

Place that line just before calling `getFreshAgentThreadSnapshot(...)`, so it captures the global status at request start.

Then, inside the `.then(...)` callback after `nextStatus` is computed:

```ts
const hasBlockingLocalEchoForSession = hasUnresolvedLocalEchoForSessionRef.current
const sessionStatus = nextStatus === 'create-failed' ? null : nextStatus
const snapshotIsBusy = sessionStatus === 'running' || sessionStatus === 'compacting'
const statusChangedSinceRequest = agentSessionStatusVersionRef.current !== requestAgentSessionStatusVersion
const currentSessionStatus = agentSessionStatusRef.current ?? fresh.status
const wouldRegressStatus = sessionStatus
  ? isStatusRegression(currentSessionStatus, sessionStatus)
  : false
if (
  sessionStatus
  && nextSessionId
  && provider === 'codex'
  && requestSessionType === 'freshcodex'
  && !wouldRegressStatus
  && (
    snapshotIsBusy
    || (!hasBlockingLocalEchoForSession && !statusChangedSinceRequest)
  )
) {
  dispatch(setSessionStatus({
    sessionId: nextSessionId,
    sessionType: requestSessionType,
    provider,
    status: sessionStatus,
  }))
}
```

Do not dispatch `freshAgentSnapshotReceived` here. The bug is stale status, and the REST snapshot path must not replace global turns, pending approvals, token usage, or provider-specific state.

Keep this dispatch after `isStaleSnapshotRequest()` returns false. Use the status from the raw `resolved` snapshot, but keep history display merging local to the component.

Do not add `hasUnresolvedLocalEchoForSession` to the snapshot-loading `useEffect` dependency list. That effect is intentionally identity-only and reads non-identity values through refs to avoid self-triggered duplicate snapshot fetches. The async reconciliation guard must read `hasUnresolvedLocalEchoForSessionRef.current` when the REST snapshot resolves.

Keep the `if (...)` condition inline as shown rather than moving it into a separate `shouldReconcileSessionStatus` boolean. TypeScript needs the direct `sessionStatus && nextSessionId` guard to narrow `status` to `FreshAgentSessionStatus` and `sessionId` to `string` for `setSessionStatus(...)`.

- [x] **Step 5a: Keep idle reconciliation blocked while local echo is unresolved**

The guard must not dispatch idle when all of these are true:

```ts
provider === 'codex'
&& requestSessionType === 'freshcodex'
&& nextStatus !== 'create-failed'
&& nextStatus !== 'running'
&& nextStatus !== 'compacting'
&& hasUnresolvedLocalEchoForSessionRef.current
```

This preserves the status during the window after a user send in any same-session pane in `state.panes.layouts` but before the server snapshot contains that turn.
The guard is intentionally conservative: if the current pane's echo landed but a sibling pane for the same session still has unresolved `pendingLocalEcho`, do not reconcile idle yet. One extra fallback poll after the echo clears is preferable to incorrectly idling a session with an in-flight sibling send.

The guard must also not dispatch non-busy status when `agentSessionStatusVersionRef.current !== requestAgentSessionStatusVersion`, because that means a newer global status arrived while the REST request was in flight.

Use the status-version ref for this guard:

```ts
agentSessionStatusVersionRef.current !== requestAgentSessionStatusVersion
```

Do not use status-string equality as the freshness guard; same-value `running` updates must still block an older REST `idle` response.

- [x] **Step 6: Run the focused tests to verify GREEN**

Run:

```bash
npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "freshcodex REST snapshot|same-valued running session status|unresolved local echo"
```

Expected: PASS.

- [x] **Step 7: Run nearby client tests**

Run:

```bash
npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: PASS.

- [x] **Step 8: Commit Task 1**

Run:

```bash
git add src/store/freshAgentTypes.ts src/store/freshAgentSlice.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx docs/superpowers/plans/2026-06-25-freshcodex-bounce-and-recovery.md
git commit -m "fix(fresh-agent): reconcile REST snapshots into live status"
```

## Task 2: Bound Terminal-Mode Codex Durable Recovery Retries

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.codex-sidecar.test.ts`

**Interfaces:**
- Consumes: `CodexRecoveryOptions` passed through `providerSettings.codexAppServer.recovery`.
- Produces: optional `maxConsecutiveFailures?: number` on `CodexRecoveryOptions`, defaulting to 5 when omitted and clamped to at least 1.
- Produces: `TerminalRecord.codexRecoveryConsecutiveFailures?: number`, incremented for all retryable recovery failures and reset to 0 only after a replacement PTY/sidecar is actually published.

- [x] **Step 1: Write the failing recovery backstop test**

In `test/unit/server/terminal-registry.codex-sidecar.test.ts`, add this test near the existing repeated-candidate-exit tests:

```ts
  it('blocks lifecycle-loss durable recovery after configured consecutive candidate exits', async () => {
    const registry = new TerminalRegistry()
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => {
      const attempt = planCreate.mock.calls.length
      return {
        sessionId: 'thread-1',
        remote: { wsUrl: `ws://127.0.0.1:${43124 + attempt}` },
        sidecar: createFakeSidecar({
          adopt: async () => {
            mockPtyProcess.instances[attempt]._emitExit(42)
          },
        }),
      }
    })
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: {
            planCreate,
            retryDelayMs: 0,
            maxConsecutiveFailures: 3,
          },
        },
      } as any,
    })
    mockPtyProcess.instances[0].autoExitOnKill = false

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })

    await vi.waitFor(() => expect(planCreate).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => {
      expect(registry.get(term.terminalId)?.codexRecoveryBlockedError?.message).toContain('failed 3 consecutive times')
    })
    await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
    expect(exited).toHaveBeenCalledWith({ terminalId: term.terminalId, exitCode: 0 })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(planCreate).toHaveBeenCalledTimes(3)
  })
```

- [x] **Step 2: Add the remaining recovery-budget regression tests**

In `test/unit/server/terminal-registry.codex-sidecar.test.ts`, add focused tests for these cases:

- Omitted `maxConsecutiveFailures` uses the default budget of 5. Trigger five retryable candidate failures and assert `planCreate` stops at 5 and `codexRecoveryBlockedError.message` contains `failed 5 consecutive times`.
- Invalid `maxConsecutiveFailures: 0` is clamped to 1. Trigger one retryable candidate failure and assert the terminal blocks without a second `planCreate`.
- Mixed retryable failures share one budget. Use `maxConsecutiveFailures: 3` and make the first attempt reject from `planCreate`, the second attempt produce a candidate PTY exit before publication, and the third attempt reject from candidate `adopt`; assert the shared budget blocks after the third generic failure.
- A successful publication resets the counter. Use `maxConsecutiveFailures: 3`, fail twice, publish a replacement on the third attempt, trigger another lifecycle-loss recovery on the replacement, fail twice again, then publish another replacement. Assert it does not block after the fourth total failure because the counter reset on the first publication.
- A PTY-exit-triggered recovery budget exhaustion finalizes through the PTY-exit branch. Trigger recovery from an unclean Codex PTY exit rather than lifecycle loss, exhaust a small budget, assert the terminal reaches `exited`, and assert no further `planCreate` calls occur.

Do not add a test that resets the counter merely because `runCodexRecoveryAttempt(...)` returns. Some return paths mean the attempt was abandoned because the terminal was closed, replaced, or otherwise made ineligible; those must not count as successful publication.

- [x] **Step 3: Run the focused server tests to verify RED**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: FAIL because `CodexRecoveryOptions` has no `maxConsecutiveFailures` and the recovery loop retries forever.

- [x] **Step 4: Add the bounded recovery implementation**

In `server/terminal-registry.ts`, update `CodexRecoveryOptions`:

```ts
export type CodexRecoveryOptions = {
  planCreate(input: CodexRecoveryLaunchInput): Promise<CodexLaunchPlan>
  retryDelayMs?: number
  maxConsecutiveFailures?: number
}
```

Add a module-level default near the other Codex recovery constants:

```ts
const CODEX_DURABLE_RECOVERY_MAX_CONSECUTIVE_FAILURES = 5
```

Add the counter to `TerminalRecord`:

```ts
  codexRecoveryConsecutiveFailures?: number
```

In `runCodexRecoveryLoop`, leave the counter unchanged when the attempt returns:

```ts
        await this.runCodexRecoveryAttempt(record, resumeSessionId)
        return
```

Do **not** reset the counter here. `runCodexRecoveryAttempt(...)` can return without publishing a replacement when recovery becomes invalid mid-attempt. Resetting here would hide real consecutive failures behind an abandoned attempt.

Instead, reset the counter only after the successful handoff block publishes the replacement PTY/sidecar in `runCodexRecoveryAttempt(...)`, next to the existing `published = true` assignment:

```ts
      published = true
      record.codexRecoveryConsecutiveFailures = 0
```

In the retryable-error branch, before logging and waiting for the next retry, increment and enforce the budget:

```ts
        const failureCount = (record.codexRecoveryConsecutiveFailures ?? 0) + 1
        record.codexRecoveryConsecutiveFailures = failureCount
        const maxConsecutiveFailures = Math.max(
          1,
          record.codexRecovery?.maxConsecutiveFailures
            ?? CODEX_DURABLE_RECOVERY_MAX_CONSECUTIVE_FAILURES,
        )
        if (failureCount >= maxConsecutiveFailures) {
          const blocked = new Error(
            `Codex durable recovery failed ${failureCount} consecutive times; refusing to retry forever.`,
            { cause: err },
          )
          this.blockCodexRecovery(record, blocked)
          throw blocked
        }
        logger.warn(
          {
            err,
            terminalId,
            resumeSessionId: record.resumeSessionId,
            failureCount,
            maxConsecutiveFailures,
          },
          'Codex durable recovery candidate failed; retrying after teardown',
        )
```

Keep teardown-class errors immediately blocked as they are today. Do not reset the counter on failed candidate shutdown; only successful publication resets it.

Update the stale blocked-recovery log text in `startCodexDurableRecovery(...)` from “blocked by a previous sidecar teardown failure” to wording that covers both teardown failures and exhausted retry budgets, for example:

```ts
'Codex durable recovery is blocked by a previous recovery failure'
```

- [x] **Step 5: Run the focused server tests to verify GREEN**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

- [x] **Step 6: Run nearby server recovery tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 2**

Run:

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-sidecar.test.ts docs/superpowers/plans/2026-06-25-freshcodex-bounce-and-recovery.md
git commit -m "fix(codex): bound durable recovery retries"
```

## Task 3: Final Verification And Branch Hygiene

**Files:**
- Modify only if earlier tasks reveal a small follow-up needed in the same files.

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: one branch that passes focused tests, typecheck, and the coordinated full check.

- [x] **Step 1: Run focused client and server coverage together**

Run:

```bash
npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS for both commands.

- [x] **Step 2: Run lint/type/full coordinated verification**

Run:

```bash
FRESHELL_TEST_SUMMARY="freshcodex bounce and bounded codex recovery" npm run check
```

Expected: PASS.

- [x] **Step 3: Inspect the branch diff**

Run:

```bash
git diff --stat origin/main...HEAD
git status --short --branch
```

Expected: only the planned source/test/plan files are changed, and the worktree is clean after commits.

- [x] **Step 4: Commit any verification-only follow-up**

If Step 1 or Step 2 required small fixes, commit them:

```bash
git add src/store/freshAgentTypes.ts src/store/freshAgentSlice.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx server/terminal-registry.ts test/unit/server/terminal-registry.codex-sidecar.test.ts docs/superpowers/plans/2026-06-25-freshcodex-bounce-and-recovery.md
git commit -m "test: verify freshcodex recovery regressions"
```

If no files changed, do not create an empty commit.
