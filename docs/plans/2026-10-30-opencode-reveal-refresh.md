# OpenCode Pane Reveal After an Unchanged Revision Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh implementer and a specification-plus-quality review after every task. Track progress with the checkbox steps below.

## User Request

### Requested result
Fix Freshell so a successful OpenCode conversation snapshot refresh makes the pane visible after reconnect, even when the conversation revision is unchanged.

### Explicit constraints
- Follow the repository’s usual repair and review workflow.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** After a hidden OpenCode pane reconnects, a successful current reveal snapshot makes its transcript visible even when the returned revision equals the revision captured when the pane became dirty.

**Architecture:** The reconnect handler already marks the transcript dirty while hidden and defers snapshot hydration until reveal. `FreshAgentView` commits a successful snapshot before deciding whether to clear that dirty state, and its request identity, owner, boot, refresh-serial, and dirty-version checks fence stale responses. Extend only the revision predicate so an equal revision is fresh evidence for OpenCode; keep the current retry behavior for lower revisions and other providers, and prove the reconnect callback plus the browser-visible result.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, Vitest, Testing Library, Playwright, and the existing Fresh Agent snapshot scheduler.

## Global Constraints

- Continue in the existing dedicated worktree and branch based on the captured clean `origin/main` commit. Do not modify unrelated files.
- Use the pinned pnpm 10.34.5 and the repo-owned test commands below. Do not use npm installs, raw Vitest, or `npx`.
- The Vitest and browser e2e backends are already configured as cloud in this workspace; run the focused commands through that configuration. `freshopencode-transcript-scroll.spec.ts` and `freshopencode-snapshot-409-recovery.spec.ts` are not in the cloud skip list.
- Preserve current stale-response fences and the rule that lower OpenCode revisions remain blocked. The equal-revision exception applies only to a successful, current reveal snapshot for provider `opencode`; other providers retain the existing revision comparison.
- Do not change API or WebSocket schemas, persisted state, dependencies, settings, or the Rust snapshot producer. No migration or rollback action is needed because the changed state is client memory and reverting the source change restores the old behavior.
- Keep the existing structured snapshot request and display audit events. This change creates no new request outcome that needs a new event.
- This is a focused visibility bug fix, not a new usage flow or significant UI redesign, so it requires no README or `docs/index.html` update. Do not restart or deploy the self-hosted server.
- Follow the repository’s usual implementation and review workflow. Do not create a PR or merge without the required explicit approval.

---

### Task 1: Reveal a successfully refreshed OpenCode pane at an unchanged revision

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:3400`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts`

**Interfaces:**
- Consumes: `FreshAgentView`'s local `applySnapshot(next: FreshAgentSnapshot)` path, the existing `trigger: 'reveal'` tag, `snapshotDirtyBaseRevisionRef`, and the current request and reveal freshness fences. The component test uses the existing `freshopencodeSnapshot(text, revision)` fixture, `StoreBackedFreshAgentView`, and `wsMock.onReconnect`. The browser test uses the existing `routeFreshopencodeSnapshot`, `harness.receiveWsMessage`, and pane creation helpers.
- Produces: No exported signature or wire change. For `provider === 'opencode'`, a successful current reveal snapshot whose numeric revision equals `snapshotDirtyBaseRevisionRef.current` passes the existing success-clear path. Lower revisions remain blocked, and all other providers keep the existing comparison.

- [ ] **Step 1: Write the failing behavioral tests**

Add this test beside the existing reveal-lane recovery test in `FreshAgentView.test.tsx`. It drives the actual hidden reconnect callback, verifies that no snapshot is fetched while hidden, then resolves the reveal fetch with the same OpenCode revision as the initial snapshot.

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
    expect(screen.getByText('same-revision transcript')).toBeVisible()
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

Add this browser test to the existing `Freshopencode transcript scrolling` describe block. The route starts with revision `1`; deliberately do not call `snapshot.replaceTurns`, so the reveal fetch returns the same transcript and revision after the hidden invalidation.

```ts
test('reveals the current OpenCode transcript after a hidden refresh with an unchanged revision', async ({
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

  await harness.receiveWsMessage({
    type: 'freshAgent.event',
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionId: SESSION_ID,
    event: {
      type: 'freshAgent.session.changed',
      sessionId: SESSION_ID,
    },
  })

  await revealTab(page, freshTabId!)
  await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(freshTabId)
  await expect.poll(() => snapshot.getRevealRefreshRequests(), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(transcript.getByText(FINAL_TRANSCRIPT_MARKER)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('status', { name: 'Refreshing conversation' })).toHaveCount(0)
})
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL at the new `toBeVisible()` assertion because the successful reveal response has revision `5`, equal to the dirty base revision `5`, so the transcript remains hidden behind the refresh state.

Run: `pnpm run test:e2e --project=chromium test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts`

Expected: FAIL only in the new test when the unchanged transcript remains invisible after the reveal request; the existing scrolling test still passes.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentView.tsx`, keep `revealRefreshIsCurrent` and the existing clear/retry branches unchanged. Extend only the `revealRevisionIsFresh` expression with an OpenCode equality case:

```ts
const revealRevisionIsFresh = snapshotDirtyBaseRevisionRef.current === null
  || typeof resolved.revision !== 'number'
  || resolved.revision > snapshotDirtyBaseRevisionRef.current
  || (provider === 'opencode' && resolved.revision === snapshotDirtyBaseRevisionRef.current)
```

This lets the already-fenced successful OpenCode reveal clear `snapshotDirty`, its retry timer, and its error state when the revision is unchanged. It does not let an older revision through and does not alter another provider's behavior.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS, including the reconnect test's assertion that the transcript becomes visible and no retry request follows.

Run: `pnpm run test:e2e --project=chromium test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts`

Expected: PASS, including the new browser test's visible transcript assertion after the unchanged-revision reveal.

- [ ] **Step 5: Refactor while green**

No refactor is needed. The change is one additional case in the existing revision predicate; extracting a helper or changing the scheduler would add indirection without improving this behavior. Leave all existing request and ownership fences in place.

- [ ] **Step 6: Run impacted-test verification**

The component path shares reveal hydration with hidden-pane recovery, and the existing snapshot-409 test covers a successful reveal after a failed request. Run those adjacent tests and the scheduler unit tests alongside the changed tests.

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx test/unit/client/lib/fresh-agent-snapshot-scheduler.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS; the unchanged-revision exception applies only to current OpenCode reveal responses, while other reveal, coalescing, and recovery behavior remains covered.

Run: `pnpm run typecheck:client`

Expected: PASS; the modified snapshot revision predicate typechecks with the existing provider and snapshot types.

Run: `pnpm run test:e2e --project=chromium test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts test/e2e-browser/specs/freshopencode-snapshot-409-recovery.spec.ts`

Expected: PASS on the configured cloud backend; the browser transcript remains visible after same-revision hydration and the existing 409 recovery still renders its recovered snapshot.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e-browser/specs/freshopencode-transcript-scroll.spec.ts
git commit -m "fix: reveal OpenCode pane after unchanged snapshot refresh"
```
