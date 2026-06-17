# OpenCode Refresh Restore White Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent restored OpenCode CLI panes from becoming visually blank after browser refresh by ensuring hidden restored OpenCode PTYs get an immediate terminal-emulation attach.

**Architecture:** Keep the existing visible replay-gap repair path. Add one OpenCode-specific hidden-create branch in `TerminalView`: restored hidden OpenCode terminals should perform a background `viewport_hydrate` attach as soon as `terminal.created` arrives, while ordinary hidden terminals keep deferring until reveal. Tests prove the behavior at the lifecycle boundary and through an OpenCode refresh/reveal flow.

**Tech Stack:** React 18, Redux Toolkit, xterm.js, Vitest, Playwright e2e-browser harness, Freshell WebSocket terminal protocol.

## Global Constraints

- Work in `/home/dan/code/freshell/.worktrees/opencode-refresh-restore-white-page` on branch `fix/opencode-refresh-restore-white-page`.
- Keep the change scoped to OpenCode CLI terminal restore/hydration; do not change fresh-agent or `freshopencode`.
- Do not restart the self-hosted Freshell server.
- Use NodeNext/ESM-compatible imports; relative server imports must keep `.js` extensions.
- Preserve existing hidden terminal behavior for shell, Codex, Claude, Gemini, and Kimi.
- Tests must prove behavior, not static strings.
- Commit each completed task.

---

## File Structure

- Modify `src/components/TerminalView.tsx`: add the OpenCode hidden restored attach policy in the `terminal.created` handler.
- Modify `test/unit/client/components/TerminalView.lifecycle.test.tsx`: add focused lifecycle regression coverage and keep existing hidden-create expectations for non-OpenCode terminals.
- Modify `test/e2e-browser/specs/opencode-restart-recovery.spec.ts`: extend OpenCode refresh coverage to prove a hidden restored OpenCode pane is visibly hydrated after reveal.

### Task 1: OpenCode Hidden Restore Attach Policy

**Files:**
- Modify: `src/components/TerminalView.tsx:3601-3685`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx:3705-3736`

**Interfaces:**
- Consumes: `launchAttemptRef.current.restore`, `contentRef.current.mode`, `contentRef.current.sessionRef`, and existing `attachTerminal(tid, intent, opts)`.
- Produces: hidden restored OpenCode panes send `terminal.attach` with `intent: 'viewport_hydrate'`, `priority: 'background'`, and `sinceSeq: 0` immediately after `terminal.created`.

- [ ] **Step 1: Write the failing lifecycle test**

Add this test immediately after `hidden create path defers attach until visible and measured` in `test/unit/client/components/TerminalView.lifecycle.test.tsx`:

```tsx
it('hidden restored OpenCode create attaches in the background before reveal', async () => {
  const sessionRef = { provider: 'opencode', sessionId: 'ses_hidden_restore_owner' } as const
  restoreMocks.consumeTerminalRestoreRequestId.mockImplementation((id: string) => id === 'req-v2-hidden-opencode-restore')

  const { requestId } = await renderTerminalHarness({
    status: 'creating',
    hidden: true,
    mode: 'opencode',
    requestId: 'req-v2-hidden-opencode-restore',
    sessionRef,
  })

  wsMocks.send.mockClear()
  act(() => {
    messageHandler!({
      type: 'terminal.created',
      requestId,
      terminalId: 'term-hidden-opencode-restore',
      createdAt: Date.now(),
      sessionRef,
    })
  })

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-hidden-opencode-restore',
      intent: 'viewport_hydrate',
      priority: 'background',
      sinceSeq: 0,
      attachRequestId: expect.any(String),
    }))
  })
})
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "hidden restored OpenCode create attaches in the background before reveal"
```

Expected: FAIL because hidden `terminal.created` currently stores a deferred attach and sends no `terminal.attach`.

- [ ] **Step 3: Implement the OpenCode-only hidden attach branch**

In `src/components/TerminalView.tsx`, replace the hidden branch in the `terminal.created` handler with this shape:

```tsx
const createdRestoreLaunch = launchAttemptRef.current?.terminalId === newId
  && launchAttemptRef.current.restore === true
const currentSessionRef = contentRef.current?.sessionRef
const shouldBackgroundHydrateHiddenOpenCode = hiddenRef.current
  && createdRestoreLaunch
  && contentRef.current?.mode === 'opencode'
  && currentSessionRef?.provider === 'opencode'

if (hiddenRef.current && shouldBackgroundHydrateHiddenOpenCode) {
  attachTerminal(newId, 'viewport_hydrate', {
    clearViewportFirst: true,
    priority: 'background',
    ...viewportHydrateReplayOptions(contentRef.current),
  })
} else if (hiddenRef.current) {
  deferredAttachStateRef.current = {
    mode: 'waiting_for_geometry',
    pendingIntent: 'viewport_hydrate',
    pendingSinceSeq: 0,
    pendingReason: 'terminal_created',
  }
  setIsAttaching(false)
} else {
  attachTerminal(newId, 'viewport_hydrate', { clearViewportFirst: true })
}
```

Keep this logic after `updateContent(...)` and session association reconciliation so `contentRef.current.sessionRef` has the canonical OpenCode session before the branch runs.

- [ ] **Step 4: Run focused lifecycle coverage**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "hidden create path defers attach until visible and measured|hidden restored OpenCode create attaches in the background before reveal|recreates a restored OpenCode pane when visible viewport hydration cannot replay startup output"
```

Expected: PASS. This confirms ordinary hidden creates still defer, OpenCode restored hidden creates attach immediately, and existing visible replay-gap replacement still works.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: hydrate hidden restored opencode panes"
```

### Task 2: Browser Refresh Visual Regression Coverage

**Files:**
- Modify: `test/e2e-browser/specs/opencode-restart-recovery.spec.ts:614-765`

**Interfaces:**
- Consumes: existing `recovers a hidden OpenCode sessionRef when association lands while the browser is closed` scenario, `TestHarness`, and `getPaneSnapshots`.
- Produces: an assertion that a restored hidden OpenCode pane has rendered terminal output after it is revealed, not only a valid session id.

- [ ] **Step 1: Write the failing e2e assertion**

In `recovers a hidden OpenCode sessionRef when association lands while the browser is closed`, after the restored page reveals the OpenCode tab and before sending `hidden-after-refresh`, add:

```ts
await expect.poll(async () => {
  return restorePage!.evaluate((targetTabId) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const findTerminal = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
      if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
      return undefined
    }
    const content = findTerminal(state?.panes?.layouts?.[targetTabId])
    if (!content?.terminalId) return ''
    return harness?.getTerminalBuffer?.(content.terminalId)?.trim() ?? ''
  }, tabId)
}, {
  timeout: 30_000,
  message: 'expected restored hidden OpenCode pane to render terminal content after reveal',
}).not.toBe('')
```

- [ ] **Step 2: Run the e2e-browser scenario**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts -g "recovers a hidden OpenCode sessionRef when association lands while the browser is closed"
```

Expected before Task 1 implementation: FAIL intermittently or time out when hidden restored OpenCode has no terminal-emulation owner. Expected after Task 1: PASS.

- [ ] **Step 3: Adjust only if harness naming differs**

If TypeScript reports the terminal buffer helper under a different name, inspect the harness type and update the call to the existing helper. Do not add a new test-only harness API unless the helper is genuinely absent.

- [ ] **Step 4: Run OpenCode restart recovery browser coverage**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add test/e2e-browser/specs/opencode-restart-recovery.spec.ts
git commit -m "test: cover opencode hidden refresh rendering"
```

### Task 3: Final Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: commits from Tasks 1 and 2.
- Produces: evidence that the branch is ready for final review.

- [ ] **Step 1: Run targeted unit coverage**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "hidden create path defers attach until visible and measured|hidden restored OpenCode create attaches in the background before reveal|recreates a restored OpenCode pane when visible viewport hydration cannot replay startup output"
```

Expected: PASS.

- [ ] **Step 2: Run targeted browser coverage**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run repo-supported verification**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 4: Commit any verification-only plan updates**

If and only if the plan checkbox state is updated during execution, run:

```bash
git add docs/superpowers/plans/2026-06-17-opencode-refresh-restore-white-page.md
git commit -m "docs: update opencode restore plan progress"
```

## Self-Review

Spec coverage: The plan fixes the OpenCode CLI refresh white-page path by ensuring hidden restored OpenCode PTYs have an immediate xterm owner, keeps the existing replay-gap repair, and adds unit plus browser regression coverage.

Placeholder scan: No `TBD`, `TODO`, or undefined implementation placeholder remains.

Type consistency: The plan uses existing `TerminalPaneContent['sessionRef']`, `attachTerminal`, `viewportHydrateReplayOptions`, `launchAttemptRef`, and `terminal.attach` message fields already present in `TerminalView`.
