# OpenCode Refresh Restore White Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent restored OpenCode CLI panes from becoming visually blank after browser refresh by repairing unrecoverable hidden viewport hydration gaps instead of leaving the restored pane attached to stale output state.

**Architecture:** Keep the existing hydration queue and the visible OpenCode replay-gap repair path. Extend that same durable OpenCode replacement behavior to hidden `viewport_hydrate` attaches when the server reports `replay_window_exceeded` from `sinceSeq: 0`. Do not bypass the queue by attaching hidden `terminal.created` events directly; the reproduced browser-refresh path restores an existing `terminalId` and hydrates it while hidden or on reveal.

**Tech Stack:** React 18, Redux Toolkit, xterm.js, Vitest, Playwright e2e-browser harness, Freshell WebSocket terminal protocol.

## Global Constraints

- Work in `/home/dan/code/freshell/.worktrees/opencode-refresh-restore-white-page` on branch `fix/opencode-refresh-restore-white-page`.
- Keep the change scoped to OpenCode CLI terminal restore/hydration; do not change fresh-agent or `freshopencode`.
- Do not restart the self-hosted Freshell server.
- Use NodeNext/ESM-compatible imports; relative server imports must keep `.js` extensions.
- Preserve existing hidden terminal behavior for shell, Codex, Claude, Gemini, and Kimi.
- Tests must prove behavior, not static strings.
- Commit focused implementation work before final verification.

## Load-Bearing Amendments

- Browser refresh of a hidden OpenCode tab commonly restores an existing live `terminalId`, not a new hidden `terminal.created` path.
- A hidden `terminal.created` immediate attach would bypass the hydration queue's visible-first, single-active-pane policy, so the fix should not add that behavior.
- `terminal.attach` with an expected session is only safe when the client/session association matches server ownership. The existing restored path already reconciles session ownership before attach.
- The e2e regression must force `replay_window_exceeded` by overflowing the replay ring, then assert the restored hidden OpenCode pane is relaunched with a new terminal id and rendered terminal buffer content after reveal. Session id and stdin checks alone do not catch a white terminal surface.

---

## File Structure

- Modify `src/components/TerminalView.tsx`: let hidden OpenCode `viewport_hydrate` replay-window gaps enter the existing durable replacement flow.
- Modify `test/unit/client/components/TerminalView.lifecycle.test.tsx`: add focused lifecycle regression coverage for hidden background viewport hydration gaps.
- Modify `test/e2e-browser/specs/opencode-restart-recovery.spec.ts`: extend hidden OpenCode refresh coverage to prove the revealed restored pane renders terminal output.

### Task 1: Hidden OpenCode Replay-Gap Repair

**Files:**
- Modify: `src/components/TerminalView.tsx:3341-3378`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx:7468-7715`

**Interfaces:**
- Consumes: `terminal.output.gap`, `currentAttachRef.current`, `contentRef.current.sessionRef`, `hiddenRef.current`, and `beginOpenCodeReplacementAfterExit`.
- Produces: hidden restored OpenCode panes replace the stale PTY when a full viewport hydrate cannot replay from seq `0`.

- [ ] **Step 1: Write the failing lifecycle test**

Add a unit test near the existing visible OpenCode replay-gap replacement test:

```tsx
it('recreates a hidden restored OpenCode pane when background viewport hydration cannot replay startup output', async () => {
  const sessionRef = { provider: 'opencode', sessionId: 'ses_hidden_replay_gap' } as const
  const addedRestoreIds = new Set<string>()
  restoreMocks.addTerminalRestoreRequestId.mockImplementation((id: string) => {
    addedRestoreIds.add(id)
  })
  restoreMocks.consumeTerminalRestoreRequestId.mockImplementation((id: string) => {
    if (addedRestoreIds.has(id)) {
      addedRestoreIds.delete(id)
      return true
    }
    return false
  })

  const { store, tabId, terminalId } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-opencode-hidden-gap',
    mode: 'opencode',
    hidden: true,
    clearSends: false,
    requestId: 'req-opencode-hidden-gap',
    sessionRef,
  })

  wsMocks.send.mockClear()
  act(() => {
    getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])
  })

  let attach: any
  await waitFor(() => {
    attach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) =>
        msg?.type === 'terminal.attach'
        && msg?.terminalId === terminalId
        && msg?.intent === 'viewport_hydrate'
        && msg?.priority === 'background'
      )
    expect(attach?.attachRequestId).toBeTruthy()
  })

  act(() => {
    messageHandler!({
      type: 'terminal.attach.ready',
      terminalId,
      headSeq: 120,
      replayFromSeq: 42,
      replayToSeq: 120,
      attachRequestId: attach.attachRequestId,
    })
  })
  act(() => {
    messageHandler!({
      type: 'terminal.output.gap',
      terminalId,
      fromSeq: 1,
      toSeq: 41,
      reason: 'replay_window_exceeded',
      attachRequestId: attach.attachRequestId,
    } as any)
  })

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith({
      type: 'terminal.kill',
      terminalId,
    })
  })

  act(() => {
    messageHandler!({
      type: 'terminal.exit',
      terminalId,
      exitCode: 0,
    })
  })

  let replacementRequestId: string | undefined
  await waitFor(() => {
    const layout = store.getState().panes.layouts[tabId]
    expect(layout?.type).toBe('leaf')
    if (layout?.type !== 'leaf' || layout.content.kind !== 'terminal') {
      throw new Error('expected terminal pane')
    }
    expect(layout.content.terminalId).toBeUndefined()
    expect(layout.content.status).toBe('creating')
    expect(layout.content.sessionRef).toEqual(sessionRef)
    replacementRequestId = layout.content.createRequestId
    expect(replacementRequestId).not.toBe('req-opencode-hidden-gap')
  })

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.create',
      requestId: replacementRequestId,
      mode: 'opencode',
      sessionRef,
      restore: true,
    }))
  })
})
```

Also import `getHydrationQueue` from `@/lib/hydration-queue` in the test file.

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "recreates a hidden restored OpenCode pane when background viewport hydration cannot replay startup output"
```

Expected: FAIL because `isUnrecoverableOpenCodeViewportHydrate` currently requires `!hiddenRef.current`, so the hidden gap writes a local output notice instead of replacing the stale OpenCode PTY.

- [ ] **Step 3: Implement the hidden OpenCode repair branch**

In `src/components/TerminalView.tsx`, remove the `!hiddenRef.current` requirement from `isUnrecoverableOpenCodeViewportHydrate`. Keep the other guards:

- `msg.reason === 'replay_window_exceeded'`
- current attach intent is `viewport_hydrate`
- attach `sinceSeq` is `0`
- pane mode is `opencode`
- `sessionRef.provider === 'opencode'`

Do not broaden the behavior to `replay_budget_exceeded`, non-OpenCode modes, or delta attaches.

- [ ] **Step 4: Run focused lifecycle coverage**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "recreates a hidden restored OpenCode pane when background viewport hydration cannot replay startup output|recreates a restored OpenCode pane when visible viewport hydration cannot replay startup output|background hydrates a trusted hidden reconnect from rendered high-water with background priority"
```

Expected: PASS. This confirms hidden OpenCode gaps repair, the visible repair still works, and hidden background hydration still uses the queue.

### Task 2: Browser Refresh Visual Regression Coverage

**Files:**
- Modify: `test/e2e-browser/specs/opencode-restart-recovery.spec.ts:614-765`

**Interfaces:**
- Consumes: existing `recovers a hidden OpenCode sessionRef when association lands while the browser is closed` scenario, per-test server env overrides, `waitForRestoreLaunches`, and `TestHarness.getTerminalBuffer`.
- Produces: assertions that a forced hidden `replay_window_exceeded` gap relaunches OpenCode on a new terminal id and renders terminal output after reveal.

- [ ] **Step 1: Allow per-test replay-ring sizing**

Extend this spec-local helper input:

```ts
function createServerOptions(input: {
  binDir: string
  auditLogPath: string
  logsDir: string
  sharedOpencodeDataDir: string
  fakeOpencodeSessionEventGatePath?: string
  port?: number
  token?: string
  env?: Record<string, string>
}) {
```

and spread `input.env` into the returned `env` object after the existing defaults:

```ts
      FRESHELL_LOG_DIR: input.logsDir,
      ...(input.env ?? {}),
```

This keeps other tests unchanged while letting this scenario lower the coding CLI replay ring.

- [ ] **Step 2: Force the hidden replay-window gap**

In `recovers a hidden OpenCode sessionRef when association lands while the browser is closed`, pass a small scrollback/replay budget into `createServerOptions`:

```ts
env: {
  MAX_SCROLLBACK_CHARS: String(64 * 1024),
  CODING_CLI_MIN_REPLAY_RING_MAX_BYTES: String(64 * 1024),
},
```

After `expectedSessionId` is known and before the existing `hidden-before-refresh` input, send a large payload:

```ts
await sendInputToTerminals(page, [beforeAssociation], `hidden-overflow-${'x'.repeat(96 * 1024)}`)
```

Then keep the existing smaller `hidden-before-refresh` send and audit wait. The large fake OpenCode stdin echo overflows the reduced ring; the smaller input gives the existing audit a compact stable marker.

- [ ] **Step 3: Stop requiring the stale hidden terminal id before reveal**

In the restored-page hidden wait, keep the assertions for active shell tab, OpenCode tab sessionRef, content mode, and content sessionRef, but remove `content.terminalId === expectedTerminalId`. Once the hidden background queue repairs the gap, the content may already be creating or running with a replacement terminal id before the user clicks the tab.

- [ ] **Step 4: Assert relaunch and rendered output after reveal**

After revealing the OpenCode tab, wait specifically for a running replacement terminal id:

```ts
const [afterRefresh] = await waitForRunningTerminals(restorePage, [opencodeTab.tabId], {
  [opencodeTab.tabId]: beforeAssociation.terminalId,
})
expect(afterRefresh.sessionRef).toEqual({
  provider: 'opencode',
  sessionId: expectedSessionId,
})
expect(afterRefresh.terminalId).toBeTruthy()
expect(afterRefresh.terminalId).not.toBe(beforeAssociation.terminalId)
```

Then assert a restore launch occurred and the replacement terminal rendered fake OpenCode output:

```ts
await waitForRestoreLaunches(auditLogPath, [expectedSessionId])
await expect.poll(async () => {
  const buffer = await restoreHarness.getTerminalBuffer(afterRefresh.terminalId)
  return buffer ?? ''
}, {
  timeout: 30_000,
  message: 'expected restored hidden OpenCode pane to render terminal content after replay-window repair',
}).toContain(`fake opencode ready root=${expectedSessionId}`)
```

Keep the existing `hidden-after-refresh` stdin audit after these assertions.

- [ ] **Step 5: Run the e2e-browser scenario**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts -g "recovers a hidden OpenCode sessionRef when association lands while the browser is closed"
```

Expected after Task 1: PASS.

- [ ] **Step 6: Run OpenCode restart recovery browser coverage**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

Expected: PASS.

### Task 3: Commit And Final Verification

**Files:**
- Commit and verify only.

**Interfaces:**
- Consumes: completed Task 1 and Task 2 implementation work.
- Produces: evidence that the branch is ready for final review.

- [ ] **Step 1: Commit the focused change**

Run:

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e-browser/specs/opencode-restart-recovery.spec.ts docs/superpowers/plans/2026-06-17-opencode-refresh-restore-white-page.md
git commit -m "fix: repair hidden opencode refresh hydration"
```

- [ ] **Step 2: Run targeted unit coverage**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "recreates a hidden restored OpenCode pane when background viewport hydration cannot replay startup output|recreates a restored OpenCode pane when visible viewport hydration cannot replay startup output|background hydrates a trusted hidden reconnect from rendered high-water with background priority"
```

Expected: PASS.

- [ ] **Step 3: Run targeted browser coverage**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Run repo-supported verification**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit any fixes needed after verification**

If verification requires edits, make the smallest fix, rerun the covering test, then amend or add a focused follow-up commit. Do not leave the branch dirty.


## Self-Review

Spec coverage: The corrected plan protects the OpenCode CLI refresh white-page path by replacing a stale restored OpenCode PTY when hidden full-viewport hydration cannot replay startup output, and it adds both lifecycle and browser-buffer coverage.

Placeholder scan: No `TBD`, `TODO`, or undefined implementation placeholder remains.

Type consistency: The plan uses existing `TerminalPaneContent['sessionRef']`, `currentAttachRef`, `beginOpenCodeReplacementAfterExit`, hydration queue, and `terminal.attach` message fields already present in `TerminalView`.
