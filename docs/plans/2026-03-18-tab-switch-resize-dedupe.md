# Top-Tab Terminal Resize Dedupe Implementation Plan

> **For agentic workers:** REQUIRED: Use trycycle-executing to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make switching between already-live top terminal tabs with unchanged geometry stop triggering redundant `terminal.resize` traffic and the PTY repaints that look like full history replay, while preserving real resize behavior and existing attach/reconnect semantics.

**Architecture:** Make terminal layout idempotent at both choke points. On the client, `TerminalView` still runs `fit()` when a tab becomes visible, but it only sends `terminal.resize` when the post-fit `{ terminalId, cols, rows }` differs from the last size already sent for that terminal. On the server, `TerminalRegistry.resize()` becomes a no-op when the requested size already matches the live PTY record, so stray duplicate resize requests cannot still force a full-screen CLI repaint. For proof, add a bounded outbound WebSocket log to the `?e2e=1` test harness and a real browser tab-switch regression that asserts no `terminal.attach` or `terminal.resize` is emitted on same-geometry reveals.

**Tech Stack:** React 18, TypeScript, xterm.js, Redux Toolkit, Node.js, node-pty, Vitest, Playwright

---

## User-Visible Target

After this lands:

- Switching between already-live top terminal tabs with unchanged geometry must preserve the existing terminal screen without a repaint-causing `terminal.resize`.
- The hot path for those switches must emit neither `terminal.attach` nor `terminal.resize`.
- Real geometry changes must still emit exactly one effective resize and keep the terminal usable.
- First reveal of a hidden pane that has never attached is still allowed to perform its existing deferred attach flow.
- Transport reconnect, refresh attach, and hidden-remount hydration must keep their current attach semantics; this work only removes redundant same-size resize churn.

## Contracts And Invariants

These are the source-of-truth behaviors the implementation must preserve:

1. `fit()` on reveal is still allowed. The bug is not calling `fit`; it is sending same-size `terminal.resize` after `fit`.
2. Client-side resize dedupe is keyed by `terminalId + cols + rows`, not by pane id, so replacing a terminal in the same pane does not inherit stale viewport state.
3. The existing `suppressNextMatchingResizeRef` behavior stays in place for attach flows. The new dedupe layers on top of it; it does not replace attach suppression.
4. The client-side viewport cache must be seeded from every viewport-bearing send, including both `terminal.attach` and `terminal.resize`. If the cache only tracks explicit resize calls, the first reveal after an attach can still re-emit a redundant resize.
5. Server-side `resize()` remains idempotent: same-size requests return success but do not call `pty.resize()`.
6. The e2e WebSocket log records actual wire sends, not queued intent. It must stay bounded and only exist in `?e2e=1` mode.
7. The new test-harness methods and WS observer hook should be optional at the type boundary so existing non-e2e unit-test doubles do not need mechanical updates.

## Root Cause Summary

The current high-frequency path is no-op resize churn, not primarily attach replay:

- Top tabs remain mounted in `src/App.tsx`, and hidden tabs use `.tab-hidden` in `src/index.css`, so normal top-level tab switches are not unmount/remount cycles.
- `src/components/TerminalView.tsx` schedules `requestTerminalLayout({ fit: true, resize: true })` whenever a terminal becomes visible.
- `flushScheduledLayout()` always sends `terminal.resize` after `fit()` when `pending.resize` is true, even if the terminal dimensions did not change.
- `server/terminal-registry.ts` always forwards that request to `pty.resize()`.
- Full-screen CLIs such as Codex and Claude commonly repaint on any resize event, including a no-op resize, which matches the user’s “virtually all the time” symptom much better than the less-common attach replay path.

## Strategy Gate

The cleanest steady-state fix is two-layer idempotence:

- **Chosen:** dedupe on the client and guard on the server. This removes the hot-path churn and gives a defensive backstop for any duplicate resize that still escapes the client.
- **Rejected:** server-only fix. It would prevent PTY repaint, but the browser hot path would still emit noisy `terminal.resize` traffic and leave the client state machine wrong.
- **Rejected:** client-only fix. It would improve the common case, but reconnect races, old clients, or future duplicate callsites could still hit the PTY and repaint.
- **Rejected:** cache more attached tabs or rewrite attach hydration first. That treats a secondary path. The reported frequency points to resize churn, and a hot-tab cache does not solve it.
- **Rejected:** visual-only proof. The visible repaint is user-facing, but the architectural regression is redundant terminal protocol traffic. The browser test should assert both the visible continuity and the absence of redundant outbound messages.

No user decision is required. The fix is local, reversible, and consistent with the current architecture.

## File Structure

### Files to Modify

1. **`src/components/TerminalView.tsx`**
   - Add a per-terminal `lastSentViewportRef`.
   - Reset that ref when the active `terminalId` changes.
   - Seed that ref whenever `TerminalView` sends a viewport-bearing message, including `terminal.attach` and `terminal.resize`.
   - Gate `ws.send({ type: 'terminal.resize' ... })` behind both the existing attach suppression check and the new same-size dedupe check.
   - Keep reveal `fit()` behavior intact.

2. **`server/terminal-registry.ts`**
   - Make `resize()` return early when `term.cols === cols && term.rows === rows`.
   - Preserve existing behavior for real size changes and exited/non-existent terminals.

3. **`src/lib/ws-client.ts`**
   - Add an optional outbound-message observer hook invoked from `sendNow()` so e2e mode can record actual wire sends.

4. **`src/lib/test-harness.ts`**
   - Add bounded outbound WebSocket log storage and optional public methods to read and clear it.

5. **`src/App.tsx`**
   - When `?e2e=1` is active, wire the test harness’s recorder to the `WsClient` outbound observer.

6. **`test/e2e-browser/helpers/test-harness.ts`**
   - Add Playwright helper methods for clearing and reading outbound WebSocket messages.

7. **`test/e2e-browser/specs/terminal-lifecycle.spec.ts`**
   - Add a real browser regression for top-tab switching between already-live terminals with unchanged geometry.

8. **`test/unit/client/components/TerminalView.lifecycle.test.tsx`**
   - Add client-side regression coverage for same-geometry reveal and real geometry-change reveal.

9. **`test/unit/server/terminal-lifecycle.test.ts`**
   - Add server-side regression coverage for same-size resize no-op and changed-size resize pass-through.

## Task 1: Add E2E Outbound WS Observability And Write The Browser Regression

**Files:**
- Modify: `src/lib/ws-client.ts`
- Modify: `src/lib/test-harness.ts`
- Modify: `src/App.tsx`
- Modify: `test/e2e-browser/helpers/test-harness.ts`
- Modify: `test/e2e-browser/specs/terminal-lifecycle.spec.ts`

- [ ] **Step 1: Write the failing browser regression**

Add this test to `test/e2e-browser/specs/terminal-lifecycle.spec.ts` near the existing tab-switch survival coverage:

```ts
test('already-live top-tab switches do not emit terminal.attach or terminal.resize when geometry is unchanged', async ({
  page,
  harness,
  terminal,
}) => {
  await terminal.waitForTerminal()
  await terminal.waitForPrompt()

  await terminal.executeCommand('echo "tab-one-live"')
  await terminal.waitForOutput('tab-one-live')

  await page.locator('[data-context="tab-add"]').click()
  await harness.waitForTabCount(2)

  const shellButton = page.getByRole('button', { name: /^(Shell|WSL|CMD|PowerShell|Bash)$/i })
  await shellButton.click()
  await terminal.waitForPrompt({ timeout: 30_000 })
  await terminal.executeCommand('echo "tab-two-live"', 1)
  await terminal.waitForOutput('tab-two-live')

  await harness.clearSentWsMessages()

  const tabs = page.locator('[data-context="tab"]')
  await tabs.first().click()
  await terminal.waitForOutput('tab-one-live')
  await tabs.last().click()
  await terminal.waitForOutput('tab-two-live')
  await tabs.first().click()
  await terminal.waitForOutput('tab-one-live')

  const sent = await harness.getSentWsMessages()
  expect(sent.filter((msg: any) => msg?.type === 'terminal.attach')).toHaveLength(0)
  expect(sent.filter((msg: any) => msg?.type === 'terminal.resize')).toHaveLength(0)
})
```

The test is intentionally strict: once both tabs are already live and the viewport has not changed, any `terminal.attach` or `terminal.resize` is a regression.

- [ ] **Step 2: Add the minimal e2e harness support and run the browser test red**

Implement only the instrumentation required for the spec to run:

- In `src/lib/test-harness.ts`, add optional methods to the interface:

```ts
getSentWsMessages?: () => unknown[]
clearSentWsMessages?: () => void
recordSentWsMessage?: (msg: unknown) => void
```

- Store a bounded array inside `installTestHarness`:

```ts
const sentWsMessages: unknown[] = []
const recordSentWsMessage = (msg: unknown) => {
  try {
    sentWsMessages.push(JSON.parse(JSON.stringify(msg)))
  } catch {
    sentWsMessages.push(msg)
  }
  if (sentWsMessages.length > 500) sentWsMessages.shift()
}
```

- Expose `getSentWsMessages` and `clearSentWsMessages` from `window.__FRESHELL_TEST_HARNESS__`.

- In `src/lib/ws-client.ts`, add:

```ts
type OutboundMessageObserver = (msg: unknown) => void
private outboundMessageObserver?: OutboundMessageObserver

setOutboundMessageObserver(observer?: OutboundMessageObserver) {
  this.outboundMessageObserver = observer
}

private sendNow(msg: unknown) {
  this.ws?.send(JSON.stringify(msg))
  this.outboundMessageObserver?.(msg)
}
```

- In `src/App.tsx`, after installing the harness in `?e2e=1` mode, wire the recorder with optional chaining:

```ts
ws.setOutboundMessageObserver?.((msg) => {
  window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(msg)
})
```

- In `test/e2e-browser/helpers/test-harness.ts`, add:

```ts
async getSentWsMessages(): Promise<unknown[]> { ... }
async clearSentWsMessages(): Promise<void> { ... }
```

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-lifecycle.spec.ts -g "already-live top-tab switches do not emit terminal.attach or terminal.resize when geometry is unchanged"
```

Expected: FAIL because the browser still emits `terminal.resize` on same-geometry tab switches.

- [ ] **Step 3: Commit the red-spec harness groundwork**

```bash
git add src/lib/ws-client.ts src/lib/test-harness.ts src/App.tsx test/e2e-browser/helpers/test-harness.ts test/e2e-browser/specs/terminal-lifecycle.spec.ts
git commit -m "test: capture outbound ws messages for tab switch regressions"
```

## Task 2: Make `TerminalRegistry.resize()` Idempotent

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-lifecycle.test.ts`

- [ ] **Step 1: Write the failing server unit tests**

Add a new `describe('Idempotent resize')` block to `test/unit/server/terminal-lifecycle.test.ts`:

```ts
describe('Idempotent resize', () => {
  it('returns true without calling pty.resize when cols and rows are unchanged', () => {
    const term = registry.create({ mode: 'shell' })
    const pty = mockPtyProcess.instances[0]

    expect(term.cols).toBe(120)
    expect(term.rows).toBe(30)

    const result = registry.resize(term.terminalId, 120, 30)

    expect(result).toBe(true)
    expect(pty.resize).not.toHaveBeenCalled()
    expect(term.cols).toBe(120)
    expect(term.rows).toBe(30)
  })

  it('still calls pty.resize exactly once when cols or rows change', () => {
    const term = registry.create({ mode: 'shell' })
    const pty = mockPtyProcess.instances[0]

    const result = registry.resize(term.terminalId, 140, 40)

    expect(result).toBe(true)
    expect(pty.resize).toHaveBeenCalledTimes(1)
    expect(pty.resize).toHaveBeenCalledWith(140, 40)
    expect(term.cols).toBe(140)
    expect(term.rows).toBe(40)
  })
})
```

- [ ] **Step 2: Run the server test red**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/terminal-lifecycle.test.ts -t "Idempotent resize"
```

Expected: FAIL because same-size `registry.resize()` currently calls `pty.resize()`.

- [ ] **Step 3: Implement the server no-op guard**

Update `server/terminal-registry.ts`:

```ts
resize(terminalId: string, cols: number, rows: number): boolean {
  const term = this.terminals.get(terminalId)
  if (!term || term.status !== 'running') return false
  if (term.cols === cols && term.rows === rows) return true

  term.cols = cols
  term.rows = rows
  try {
    term.pty.resize(cols, rows)
  } catch (err) {
    logger.debug({ err, terminalId }, 'resize failed')
  }
  return true
}
```

This is deliberately the narrowest possible server choke point. It preserves the public contract (`true` for a valid running terminal) while preventing repaint-causing no-op PTY resizes.

- [ ] **Step 4: Run the server tests green**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/terminal-lifecycle.test.ts -t "Idempotent resize"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-lifecycle.test.ts
git commit -m "fix: ignore no-op terminal resizes in registry"
```

## Task 3: Dedupe Same-Geometry Reveal Resizes In `TerminalView`

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Write the failing client unit tests**

Add two focused tests to `test/unit/client/components/TerminalView.lifecycle.test.tsx` using the existing `renderTerminalHarness()` helper in the `v2 stream lifecycle` block:

```ts
it('does not send terminal.resize when an already-live terminal is hidden and revealed with unchanged geometry', async () => {
  const { rerender, store, tabId, paneId, terminalId } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-live-reveal-no-resize',
    clearSends: false,
  })

  const runtime = runtimeMocks.instances.at(-1)
  expect(runtime).toBeTruthy()

  wsMocks.send.mockClear()
  runtime!.fit.mockClear()

  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
    </Provider>,
  )
  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
    </Provider>,
  )

  await waitFor(() => {
    expect(runtime!.fit).toHaveBeenCalled()
  })

  const sent = wsMocks.send.mock.calls.map(([msg]) => msg)
  expect(sent.filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(0)
  expect(sent.filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)).toHaveLength(0)
})

it('sends exactly one terminal.resize when an already-live terminal is revealed after geometry changes', async () => {
  const { rerender, store, tabId, paneId, terminalId, term } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-live-reveal-real-resize',
    clearSends: false,
  })

  const runtime = runtimeMocks.instances.at(-1)
  expect(runtime).toBeTruthy()

  runtime!.fit.mockImplementation(() => {
    term.cols = 132
    term.rows = 40
  })

  wsMocks.send.mockClear()

  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
    </Provider>,
  )
  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
    </Provider>,
  )

  await waitFor(() => {
    const resizeCalls = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)
    expect(resizeCalls).toHaveLength(1)
  })
})
```

Use the existing attach-ready helpers already present later in the file. If the current helper shape is awkward, extract a tiny local helper in the test file rather than adding a new harness file.

- [ ] **Step 2: Run the client test red**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "already-live terminal"
```

Expected: FAIL because reveal currently always emits `terminal.resize` after `fit()`, even when geometry is unchanged.

- [ ] **Step 3: Implement client-side viewport dedupe**

In `src/components/TerminalView.tsx`:

1. Add a ref near the other terminal lifecycle refs:

```ts
const lastSentViewportRef = useRef<{ terminalId: string; cols: number; rows: number } | null>(null)
```

2. Reset the cached viewport when `terminalIdRef.current` changes inside the existing refs-sync effect:

```ts
if (terminalContent.terminalId !== prevTerminalId) {
  lastSentViewportRef.current = null
  ...
}
```

3. In `flushScheduledLayout()`, keep the existing `suppressNextMatchingResizeRef` branch, then add the new dedupe branch before `ws.send(...)`:

```ts
const lastSentViewport = lastSentViewportRef.current
const matchesLastSentViewport = lastSentViewport
  && lastSentViewport.terminalId === tid
  && lastSentViewport.cols === term.cols
  && lastSentViewport.rows === term.rows

if (matchesSuppressedViewport) {
  suppressNextMatchingResizeRef.current = null
} else if (!matchesLastSentViewport && !suppressNetworkEffects) {
  ws.send({ type: 'terminal.resize', terminalId: tid, cols: term.cols, rows: term.rows })
  lastSentViewportRef.current = { terminalId: tid, cols: term.cols, rows: term.rows }
}
```

4. After `attachTerminal()` sends `terminal.attach`, immediately seed `lastSentViewportRef.current` with the same `{ terminalId, cols, rows }` tuple so later reveals compare against the last viewport that actually went over the wire.

5. Do **not** remove `requestTerminalLayout({ fit: true, resize: true })` from the reveal effect. The correct fix is idempotence, not skipping fit.

6. Do **not** special-case hidden tabs beyond the current behavior. Hidden deferred attach logic already works and must stay intact.

- [ ] **Step 4: Run the client tests green**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "already-live terminal"
```

Expected: PASS.

- [ ] **Step 5: Re-run the browser regression green**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-lifecycle.spec.ts -g "already-live top-tab switches do not emit terminal.attach or terminal.resize when geometry is unchanged"
```

Expected: PASS. The outbound WebSocket log should stay empty for `terminal.attach` and `terminal.resize` across same-geometry top-tab switches.

- [ ] **Step 6: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: dedupe same-geometry terminal resizes on tab reveal"
```

## Task 4: Run Final Verification And Clean Up

**Files:**
- Modify: none unless a failing verification exposes a real defect

- [ ] **Step 1: Run the focused regression set**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/terminal-lifecycle.test.ts -t "Idempotent resize"
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "already-live terminal"
npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-lifecycle.spec.ts -g "already-live top-tab switches do not emit terminal.attach or terminal.resize when geometry is unchanged"
```

Expected: all PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 3: Wait for the coordinator if needed, then run the broad repo gate**

First check:

```bash
npm run test:status
```

If idle, run:

```bash
FRESHELL_TEST_SUMMARY="top-tab resize dedupe" npm run check
```

Expected: PASS. If the coordinator is busy, wait instead of interrupting another agent.

- [ ] **Step 4: Commit any verification-driven fixes**

If any verification step required code changes, commit them separately with a narrow message. If verification stays green with no new edits, skip this commit.

## Implementation Notes For The Executor

- Prefer extending existing tests instead of creating parallel harnesses.
- Keep the browser spec in `terminal-lifecycle.spec.ts`; it belongs with the existing "terminal survives tab switch and return" path.
- When logging outbound WS messages, record them only after `send()` succeeds so the browser test sees actual wire traffic, not queued messages that never left the client.
- Keep the outbound WS log bounded. This is e2e-only instrumentation, not a production telemetry feature.
- Use optional chaining on the new test-only harness methods and the WS observer hook so existing unit-test doubles stay valid without mechanical edits.
- Do not broaden the scope into attach-state rewrites or viewport snapshot work. Those may still be worth future work, but they are not necessary to fix this specific hot path.
