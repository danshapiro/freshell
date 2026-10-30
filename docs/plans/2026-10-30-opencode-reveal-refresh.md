# OpenCode Pane Reveal After an Unchanged Revision Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh implementer and a specification-plus-quality review after every task. Track progress with the checkbox steps below.

## User Request

### Requested result
Fix Freshell so a successful OpenCode conversation snapshot refresh makes the pane visible after reconnect, even when the conversation revision is unchanged.

### Explicit constraints
- Follow the repository’s usual repair and review workflow.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** After a hidden OpenCode pane reconnects, a successful current reveal snapshot can make its transcript visible at the unchanged revision when reconnect is the only reason the transcript became dirty.

**Architecture:** The reconnect handler already marks a hidden transcript dirty and defers hydration until reveal. Track whether the current dirty period still contains only a hidden reconnect: a transcript invalidation or accepted send makes that period require the existing revision advance, and later reconnects cannot relax it. Permit an equal numeric revision only for a successful, current OpenCode reveal in a reconnect-only dirty period; preserve all existing request, owner, boot, serial, version, retry, and other-provider behavior.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, Vitest, Testing Library, Playwright, and the existing Fresh Agent snapshot scheduler.

## Global Constraints

- Continue in the existing dedicated worktree and branch based on the captured clean `origin/main` commit. Do not modify unrelated files.
- Use the pinned pnpm 10.34.5 and the repo-owned test commands below. Do not use npm installs, raw Vitest, or `npx`.
- The Vitest and browser e2e backends are already configured as cloud in this workspace; run the focused commands through that configuration. `freshopencode-transcript-scroll.spec.ts` and `freshopencode-snapshot-409-recovery.spec.ts` are not in the cloud skip list.
- Preserve current stale-response fences and the rule that lower OpenCode revisions remain blocked. Equal-revision clearance applies only to a successful, current OpenCode reveal when hidden reconnect is the sole cause of the dirty period. Transcript invalidations and accepted sends must latch that period to the existing stricter revision rule; a later hidden reconnect cannot loosen it, and invalidations received while a reveal fetch is pending must supersede that fetch. Preserve current absent or nonnumeric revision fallback behavior and other-provider comparisons. Keep the exception specific to OpenCode, the provider in this request; no shared freshness contract for other providers has been established.
- Do not change API or WebSocket schemas, persisted state, dependencies, settings, or the Rust snapshot producer. No migration or rollback action is needed because the changed state is client memory and reverting the source change restores the old behavior.
- Keep the existing structured snapshot request and display audit events. This change creates no new request outcome that needs a new event.
- This is a focused visibility bug fix, not a new usage flow or significant UI redesign, so it requires no README or `docs/index.html` update. Do not restart or deploy the self-hosted server.
- Follow the repository’s usual implementation and review workflow. Do not create a PR or merge without the required explicit approval.

---

### Task 1: Reveal an OpenCode pane after reconnect without weakening transcript freshness

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:1089, 1619, 1738, 2802, 3060, 3164, 3400`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts`

**Interfaces:**
- Consumes: the local `FreshAgentView` `applySnapshot(next: FreshAgentSnapshot)` path; `snapshotDirtyRef`, `snapshotDirtyVersionRef`, and `snapshotDirtyBaseRevisionRef`; the existing `trigger: 'reveal'` request; current `wsMock.onReconnect` and `wsMock.onMessage` component-test seams; and browser harness methods `getLastReadyAt()`, `forceDisconnect()`, and `waitForConnectionAfter(previousLastReadyAt)`.
- Produces: no exported signature or wire change. A local dirty-cause marker distinguishes reconnect-only periods from periods that also include a transcript invalidation or an accepted send. Equal numeric revisions qualify only for a current OpenCode reveal in a reconnect-only period.

- [ ] **Step 1: Write the failing behavioral tests**

In `FreshAgentView.test.tsx`, add this test beside the existing reveal-lane recovery test. It fires the real component reconnect callback while hidden, confirms hydration is deferred, then reveals the pane and resolves the successful reveal request at the same OpenCode revision as the initial snapshot.

```tsx
it('reveals an OpenCode pane after reconnect when the refreshed revision is unchanged', async () => {
  vi.useFakeTimers()
  try {
    const sessionId = 'ses_reveal_same_revision'
    const sameRevisionSnapshot = () => ({
      ...freshopencodeSnapshot('same-revision transcript', 5),
      threadId: sessionId,
      sessionId,
    })
    const store = createStore()
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'opencode',
      sessionId,
      epoch: 1,
      generation: 1,
      ownerKind: 'fresh-agent',
      operationId: 'same-revision-owner',
      transition: 'handoff-committed',
    }))
    let reconnectHandler: (() => void) | undefined
    wsMock.onReconnect.mockImplementation((handler: () => void) => {
      reconnectHandler = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockImplementationOnce(() => Promise.resolve(sameRevisionSnapshot()))
      .mockImplementationOnce(() => Promise.resolve(sameRevisionSnapshot()))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-reveal-same-revision',
        sessionId,
        sessionRef: { provider: 'opencode', sessionId },
        status: 'connected',
      },
    }))

    const view = render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" hidden />
      </Provider>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('same-revision transcript')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)

    act(() => { reconnectHandler?.() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)

    view.rerender(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls[1][3]).toMatchObject({ trigger: 'reveal' })
    expect(screen.getByText('same-revision transcript')).toBeInTheDocument()
    expect(screen.queryByTestId('fresh-agent-stale-transcript')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Refreshing conversation' })).not.toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
  } finally {
    cleanup()
    resetSnapshotSchedulerForTests()
    vi.useRealTimers()
  }
})
```

Add both-ordering strict-cause coverage in the same test file. This test exercises a transcript event before and after reconnect; the equal response must stay concealed and a newer response must clear the overlay.

```tsx
it.each(['event-before-reconnect', 'event-after-reconnect'] as const)(
  'keeps OpenCode reveal strict when transcript invalidation is %s',
  async (order) => {
    vi.useFakeTimers()
    try {
      const sessionId = 'ses_strict_reveal'
      const snapshotAt = (revision: number, text: string) => ({
        ...freshopencodeSnapshot(text, revision),
        threadId: sessionId,
        sessionId,
      })
      const store = createStore()
      store.dispatch(applyRuntimeOwner({
        type: 'session.runtimeOwner',
        provider: 'opencode',
        sessionId,
        epoch: 1,
        generation: 1,
        ownerKind: 'fresh-agent',
        operationId: `strict-${order}`,
        transition: 'handoff-committed',
      }))
      let reconnectHandler: (() => void) | undefined
      let messageHandler: ((message: Record<string, unknown>) => void) | undefined
      wsMock.onReconnect.mockImplementation((handler: () => void) => {
        reconnectHandler = handler
        return () => {}
      })
      wsMock.onMessage.mockImplementation((handler) => {
        messageHandler = handler
        return () => {}
      })
      apiMock.getFreshAgentThreadSnapshot
        .mockImplementationOnce(() => Promise.resolve(snapshotAt(5, 'original transcript')))
        .mockImplementationOnce(() => Promise.resolve(snapshotAt(5, 'same-revision transcript')))
        .mockImplementationOnce(() => Promise.resolve(snapshotAt(6, 'updated transcript')))
      store.dispatch(initLayout({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: `req-strict-${order}`,
          sessionId,
          sessionRef: { provider: 'opencode', sessionId },
          status: 'connected',
        },
      }))

      const view = render(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" hidden />
        </Provider>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })

      const invalidateTranscript = () => act(() => messageHandler?.({
        type: 'freshAgent.event',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionId,
        event: { type: 'freshAgent.session.changed', sessionId },
      }))
      const reconnect = async () => {
        await act(async () => {
          reconnectHandler?.()
          await Promise.resolve()
        })
      }
      if (order === 'event-before-reconnect') {
        invalidateTranscript()
        await reconnect()
      } else {
        await reconnect()
        invalidateTranscript()
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      view.rerender(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
      expect(apiMock.getFreshAgentThreadSnapshot.mock.calls[1][3]).toMatchObject({ trigger: 'reveal' })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('status', { name: 'Refreshing conversation' })).toBeInTheDocument()
      expect(screen.getByTestId('fresh-agent-stale-transcript')).toHaveAttribute('aria-hidden', 'true')

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(3)
      expect(screen.getByText('updated transcript')).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: 'Refreshing conversation' })).not.toBeInTheDocument()
    } finally {
      cleanup()
      resetSnapshotSchedulerForTests()
      vi.useRealTimers()
    }
  },
)
```

Add a lower-revision assertion to the reconnect-only test: make the first reveal response revision `4` and keep the overlay up, then resolve the retry at revision `5` and expect it to clear. The existing equal-revision case above separately proves that revision `5` can clear immediately when reconnect is the sole dirty cause.

Add a hidden accepted-send guard: deliver an owned `freshAgent.send.accepted` frame while a pane is hidden, then reveal it; an equal-revision response must stay concealed and a newer response must clear it. This preserves the existing hidden-send behavior.

Add an owned-send overlap case for a send accepted after reveal starts. Hold the hidden-reconnect reveal response, reveal the pane, send through the existing composer, and deliver `freshAgent.send.accepted` for the captured request ID. Assert that the new request has `trigger: 'reveal'`. Resolve the old pending response at revision `5` and verify it cannot clear dirty state because it is superseded. Then resolve the current replacement reveal request at revision `5` and verify the overlay remains because send acceptance made the dirty period strict. The subsequent current retry at revision `6` must clear it. Reuse the existing send UI and `wsMock.onMessage` patterns; do not count a stale response as evidence of strict-cause handling.

In `freshopencode-transcript-scroll.spec.ts`, add this browser test to the existing `Freshopencode transcript scrolling` describe block. It hides the target tab, forces a page-local WebSocket disconnect, waits for a different completed ready handshake, then reveals the original tab. Do not inject `freshAgent.session.changed` or call `snapshot.replaceTurns`; the routed snapshot must retain the same revision and transcript.

```ts
test('reveals the OpenCode transcript after a real reconnect with an unchanged revision', async ({
  freshellPage: _freshellPage,
  page,
  harness,
  terminal,
  serverInfo,
}) => {
  await terminal.waitForTerminal()
  await routeFreshopencodeSetupApis(page)
  const snapshot = await routeFreshopencodeSnapshot(page, makeLongTranscriptTurns())
  await enableFreshopencode(page)
  await createFreshopencodePane(page)

  const pane = page.locator('[data-context="fresh-agent"][data-session-type="freshopencode"]').last()
  const transcript = pane.locator('[data-context="fresh-agent-transcript"]')
  await expect(transcript).toBeVisible({ timeout: 15_000 })
  await expect(transcript.getByText(FINAL_TRANSCRIPT_MARKER)).toBeVisible({ timeout: 15_000 })

  const freshTabId = await harness.getActiveTabId()
  expect(freshTabId).toBeTruthy()
  const hiddenTabId = await createTabViaRest(serverInfo)
  await harness.waitForTabCount(2)
  await revealTab(page, hiddenTabId)
  await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(hiddenTabId)
  await expect(page.locator('[data-tab-content-id="' + freshTabId + '"]')).toHaveClass(/tab-hidden/)

  const previousLastReadyAt = await harness.getLastReadyAt()
  await harness.forceDisconnect()
  await harness.waitForConnectionAfter(previousLastReadyAt)
  expect(await snapshot.getRevealRefreshRequests()).toBe(0)

  await revealTab(page, freshTabId!)
  await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(freshTabId)
  await expect.poll(() => snapshot.getRevealRefreshRequests(), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(transcript.getByText(FINAL_TRANSCRIPT_MARKER)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('status', { name: 'Refreshing conversation' })).toHaveCount(0)
})
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: The reconnect-only equal-revision test fails on unchanged code because the successful current revision-`5` response remains behind the refresh state. The strict-cause preservation test is expected to PASS before and after the change; it guards existing behavior and is not part of the Red failure. The owned-send overlap test fails before the change at the missing replacement `trigger: 'reveal'` request, after the pending read is superseded by the existing `send-accepted` request path. Do not change preservation assertions to force them to fail.

Run: `pnpm run test:e2e --project=chromium test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts`

Expected: FAIL only in the new test when the successful unchanged-revision reveal remains hidden. Confirm the harness observed a different completed handshake and the request was tagged `reveal`; if reconciliation replaces the synthetic pane, adjust only the test fixture so the same target conversation survives. Do not modify production reconciliation for test convenience or touch the live Freshell server.

- [ ] **Step 3: Add the minimal production implementation**

In `FreshAgentView.tsx`, add a local ref such as `snapshotDirtyRequiresRevisionAdvanceRef`, initially `false`. Extend `markSnapshotDirty` with an explicit cause: `'reconnect'`, `'transcript'`, or `'send-accepted'`. When a clean pane becomes dirty, capture its current base revision and set the marker to strict for transcript/send causes, but not for a hidden reconnect. While already dirty, any transcript or send cause latches strictness to `true`; a reconnect must never reset it. Keep the existing dirty version increment, error clearing, and mounted-state update.

Pass `'reconnect'` at the hidden reconnect call site, `'send-accepted'` at hidden accepted-send handling, and `'transcript'` at hidden or already-dirty transcript invalidation. If a send is accepted while visible and a reveal is already dirty, mark that dirty period strict and call `requestRevealRefresh(true)` so the pending reveal is superseded by a reveal-tagged read. If the pane is clean and visible, preserve the existing ordinary `'send-accepted'` snapshot request.

For the success predicate, retain the existing null-base, nonnumeric, and strictly-greater cases. Add equality only when `provider === 'opencode'`, the dirty period is not strict, the base is numeric, and `resolved.revision` equals that base. Do not change `revealRefreshIsCurrent`, request/owner/boot fences, snapshot merge behavior, or lower-revision retries. Reset the new marker both when hydration identity resets and when a current reveal successfully clears the dirty state.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS for reconnect-only equality, lower-revision blocking, both transcript/reconnect orderings, pending send acceptance, and the existing component tests.

Run: `pnpm run test:e2e --project=chromium test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts`

Expected: PASS; the actual new handshake leaves the same hidden pane dirty, and its unchanged-revision reveal displays the transcript without a refresh banner.

- [ ] **Step 5: Refactor while green**

Review the dirty-cause transitions and reset points for one clear rule: reconnect may make a clean dirty period equality-eligible, while transcript/send invalidation may only promote it to strict. Remove duplicated conditionals if the existing call sites can share a small local helper. Keep the state local to `FreshAgentView`; do not add a generic event ledger or duplicate the revision predicate. Re-run the focused component test after any refactor.

- [ ] **Step 6: Run impacted-test verification**

The component change touches hidden pane refresh, accepted-send handling, reveal recovery, and snapshot scheduling. Run the adjacent hidden-rebind and scheduler tests with the changed component tests, then typecheck and run both relevant browser specs.

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx test/unit/client/lib/fresh-agent-snapshot-scheduler.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS; strict invalidations remain concealed until a newer revision, other providers and scheduler behavior remain unchanged, and reconnect-only equal OpenCode revisions clear.

Run: `pnpm run typecheck:client`

Expected: PASS.

Run: `pnpm run lint`

Expected: PASS, including the required jsx-a11y rules.

Run: `pnpm run test:e2e --project=chromium test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts test/e2e-browser/specs/freshopencode-snapshot-409-recovery.spec.ts`

Expected: PASS on the configured cloud backend; the browser observes the real reconnect/new-handshake path and the adjacent 409 recovery continues to render its recovered snapshot.

After the final independent delta review, the usual workflow runs one full coordinated check on the final `HEAD`:

Run: `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 pnpm run check`

Expected: PASS on the configured backend; the final branch passes typecheck and the coordinated full suite. This is the final workflow gate, not a duplicate per-task run.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts
git commit -m "fix: reveal OpenCode pane after unchanged snapshot refresh"
```
