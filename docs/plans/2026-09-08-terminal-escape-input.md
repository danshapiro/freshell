# Terminal Escape Key Normal-Path Delivery Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Plain Escape pressed in a terminal pane reaches the CLI as exactly one `\x1b`
byte through xterm.js's normal key pipeline (single ingress via `onData` → `sendInput`),
with the custom-key-handler interception removed.

**Architecture:** The custom key handler in `TerminalView`'s
`term.attachCustomKeyEventHandler` currently intercepts plain Escape (calls
`preventDefault`, manually `sendInput('\u001b')`, returns `false`). The `return false`
bypasses xterm.js's entire key pipeline — the single ingress every other key uses —
skipping xterm's `cancel(e, true)` (so `stopPropagation` never runs and the keydown
propagates to ancestors) and xterm's internal key side effects (`_onKey`,
`_onUserInput`/scroll-to-bottom, textarea handling). xterm.js 6.0.0 (pinned) already
evaluates plain Escape to `C0.ESC` and delivers it via `onData` when the custom handler
returns `true` (verified from the installed bundle source). The fix removes the
interception block so Escape flows through the same path as every other key. The two
tests added by the June 2026 interception commit (`f50db7c9c`, PR #406) are rewritten to
the new contract, and a NEW real-browser Playwright spec proves with real xterm key
evaluation that a real Escape keydown still yields exactly one `\u001b`
`terminal.input` frame — the guard against the June-era failure mode that motivated the
interception (June's tests only drove the captured handler with synthetic events, so
they never exercised real xterm key evaluation).

**Tech Stack:** React 18, xterm.js 6.0.0 (`@xterm/xterm`, pinned), Vitest + Testing
Library (jsdom, default vitest config), Playwright (`rust-chromium` project, Rust test
server helper), Freshell in-page test harness
(`window.__FRESHELL_TEST_HARNESS__`).

## Global Constraints

- Work only in the worktree `.worktrees/terminal-escape-input`, branch
  `the-usual/terminal-escape-input`, forked from `origin/main` (`71186cc18`).
- Server/test files use NodeNext/ESM: relative imports in new spec files must include
  `.js` extensions (e.g. `import { RustServer } from '../helpers/rust-server.js'`).
- Focused vitest runs use the repo-owned path:
  `npm run test:vitest -- run <test-file>` (never raw `npx vitest`).
- Focused browser e2e runs use:
  `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium <spec-name-substring>`
  from the repo root. The first run builds client+server (global-setup) and the Rust
  release binary (helper, idempotent cargo build).
- Broad suites (`npm run check`, `npm run test:e2e`) go through the shared coordinator
  gate — if another agent holds it, wait; set `FRESHELL_TEST_SUMMARY` to a
  human-meaningful reason.
- Test backends are configured: `FRESHELL_VITEST_BACKEND=cloud`,
  `FRESHELL_E2E_BACKEND=cloud`.
- Accessibility: the new spec interacts via `.xterm` locator click and keyboard — the
  same accessible-interaction pattern as `silent-input-loss-rust.spec.ts`; no raw
  positional selectors.
- No user-facing UI or settings change: `docs/index.html` needs no update (keyboard
  behavior fix only).

## Requirements

- **R1 — Outcome:** Pressing plain Escape (keydown, no modifiers) in a mounted terminal
  pane results in exactly one outgoing `terminal.input` WS frame with
  `data === '\u001b'` for that pane's terminalId, delivered through xterm.js's normal
  key pipeline: the custom key handler does not intercept it, does not call
  `preventDefault`, and does not send it manually.
- **R2 — Constraint:** Every other custom-key-handler behavior is unchanged: Ctrl+F
  search, Ctrl+Shift+C copy, paste-shortcut policy (Ctrl+V / Cmd+V / Shift+Insert),
  tab switching (Ctrl+Shift+[ / ] and Alt+[ / ]), Ctrl+Shift+Arrow passthrough,
  Alt+T/W/H lifecycle keys, Shift+Enter newline, Cmd/Ctrl+End scroll. Proven by the
  existing unit and mocked-e2e keyboard suites staying green without modification
  beyond the two Escape cases being rewritten.
- **R3 — Evidence:** A real-browser Playwright spec (rust-chromium lane, also running on
  the configured cloud e2e backend) proves with real xterm key evaluation that a real
  Escape keydown produces the single `\u001b` frame on the final branch state.

---

### Task 1: Real-browser e2e characterization spec for Escape single ingress

**Requirements served:** R3 (and R1's regression guard)

**Behavior:**
- A real Escape keydown (via `page.keyboard.press('Escape')` after clicking the
  terminal) in a mounted shell pane produces exactly one `terminal.input` frame with
  `data === '\u001b'` for that pane's terminalId, observed through the in-page test
  harness's `getSentWsMessages()`.
- Liveness anchors make the assertion non-vacuous: (1) an `echo <marker>` round-trip
  proves the pane's input→PTY→output path is live before the assertion window, and
  (2) a plain `x` keypress in the same window must produce its own `terminal.input`
  frame with `data === 'x'` before Escape is pressed.
- This task runs the spec against the CURRENT (pre-removal) code, where the manual
  `sendInput` path is active: the spec must PASS on this code. This validates the
  spec's harness and records the characterization baseline. (After Task 2 removes the
  interception, the same spec must still pass — that is the June-regression guard.)

**Files:**
- Create: `test/e2e-browser/specs/terminal-escape-key-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (two registrations, see Interfaces)

**Interfaces:**
- Consumes: `RustServer` (`../helpers/rust-server.js` — `start()` →
  `{ baseUrl, port, token }`, `stop()`; skips ports 3001/3002), `TestHarness`
  (`../helpers/test-harness.js` — `waitForHarness()`, `waitForConnection()`,
  `getActiveTabId()`, `getPaneLayout(tabId)` →
  `{ content: { terminalId } }`), `TerminalHelper`
  (`../helpers/terminal-helpers.js` — `executeCommand()`, `waitForOutput()`),
  `openPanePicker` + `clickFirstVisibleShellOption`
  (`../helpers/pane-picker.js`), and the in-page harness
  `window.__FRESHELL_TEST_HARNESS__` with `clearSentWsMessages()` and
  `getSentWsMessages()` (returns JSON copies of client→server frames with `__sentAt`
  stripped).
- Produces: spec file `terminal-escape-key-rust.spec.ts` with test title
  `real Escape keydown sends exactly one ESC terminal.input frame`; registered in the
  exported `RUST_ONLY_SPECS` array (after the `silent-input-loss-rust` entry, ~line
  237) as `/terminal-escape-key-rust\.spec\.ts$/` with a one-line comment, AND in the
  `rust-chromium` project's `testMatch` (after its `silent-input-loss-rust` entry, ~line
  522) as the same regex with a one-line comment. NOT added to
  `CLOUD_SKIP_SPECS` (cloud-legal: no external CLI binaries, no restart, no
  environment-sensitive rendering).

**Test cases:**
- Spec happy path (current code, manual-send path): press `x` then `Escape` → exactly
  one frame each with `data === 'x'` and `data === '\u001b'`.
- The spec's frame filter matches `type === 'terminal.input' && terminalId === <id> &&
  data === '\u001b'` exactly, so focus-report frames (`'\u001b[I'`/`'\u001b[O'`) and
  other traffic cannot false-positive; the poll asserts count === 1 (single ingress —
  a double-send bug yields 2 and fails).

- [ ] **Step 1: Write the spec + registration**

Write `test/e2e-browser/specs/terminal-escape-key-rust.spec.ts`:

```ts
/**
 * ESC-key single-ingress regression (follow-up to PR #406 / f50db7c9c): a REAL
 * Escape keydown in a mounted terminal pane must deliver exactly one
 * terminal.input frame containing the ESC byte (\u001b) through the client's
 * normal key pipeline. Frame-level assertion via the in-page test harness
 * (deterministic, no tty-semantics dependence); liveness anchors (echo marker
 * round-trip + an 'x' keypress frame) make the assertion non-vacuous.
 *
 * Rust-only: owns a RustServer directly (registered in RUST_ONLY_SPECS +
 * rust-chromium testMatch, mirroring silent-input-loss-rust.spec.ts).
 */
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { openPanePicker, clickFirstVisibleShellOption } from '../helpers/pane-picker.js'

async function countInputFrames(page: Page, terminalId: string, data: string): Promise<number> {
  return page.evaluate(
    ({ id, needle }) => {
      const frames = (window as any).__FRESHELL_TEST_HARNESS__?.getSentWsMessages() ?? []
      return frames.filter(
        (f: any) => f?.type === 'terminal.input' && f.terminalId === id && f.data === needle,
      ).length
    },
    { id: terminalId, needle: data },
  )
}

test.describe('terminal Escape key single ingress', () => {
  test.setTimeout(120_000)

  test('real Escape keydown sends exactly one ESC terminal.input frame', async ({ page }) => {
    const server = new RustServer({ verbose: false })
    const info = await server.start()
    expect(info.port).not.toBe(3001)
    expect(info.port).not.toBe(3002)

    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await openPanePicker(page)
      await clickFirstVisibleShellOption(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const tabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
      const terminalId = (await harness.getPaneLayout(tabId))?.content?.terminalId as string

      // Liveness anchor 1: full round-trip through the pane.
      const marker = `ESC-LIVE-${randomUUID()}`
      await terminal.executeCommand(`echo ${marker}`)
      await terminal.waitForOutput(marker, { timeout: 20_000, terminalId })

      // Assertion window: clear captured frames, then press a plain key
      // (liveness anchor 2) and Escape. Each must arrive exactly once.
      await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.clearSentWsMessages())
      await page.locator('.xterm').first().click()
      await page.keyboard.press('x')
      await expect
        .poll(() => countInputFrames(page, terminalId, 'x'), { timeout: 10_000 })
        .toBe(1)

      await page.keyboard.press('Escape')
      await expect
        .poll(() => countInputFrames(page, terminalId, '\u001b'), { timeout: 10_000 })
        .toBe(1)
    } finally {
      await server.stop()
    }
  })
})
```

Register in `test/e2e-browser/playwright.config.ts`:
1. In the exported `RUST_ONLY_SPECS` array, after the `silent-input-loss-rust` entry:
   `/terminal-escape-key-rust\.spec\.ts$/,` with a one-line comment
   (`// ESC single-ingress regression: owns a RustServer directly (see spec header).`).
2. In the `rust-chromium` project's `testMatch` array, after its
   `silent-input-loss-rust` entry: `/terminal-escape-key-rust\.spec\.ts$/,` with a
   one-line comment referencing the RUST_ONLY_SPECS entry.

- [ ] **Step 2: Run the spec against the current code (characterization baseline)**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium terminal-escape-key-rust`

Expected: PASS (1 test). The current manual-send path in the custom key handler
delivers the frame; the spec's harness and anchors are validated. If it FAILS, STOP:
the current delivery is broken in a way this plan assumed intact — record the failure
and escalate for replanning before any production change.

- [ ] **Step 3: Commit the task**

```bash
git add test/e2e-browser/specs/terminal-escape-key-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): real-browser Escape single-ingress regression spec"
```

### Task 2: Route plain Escape through xterm's normal pipeline (remove interception)

**Requirements served:** R1, R2

**Behavior:**
- Plain Escape keydown (no ctrl/shift/alt/meta): the custom key handler returns `true`
  (falls through un-intercepted), does not call `preventDefault`, does not call
  `sendInput`; xterm evaluates the key and fires `onData('\x1b')`, whose existing
  handler calls `sendInput('\x1b')` → exactly one `terminal.input` frame.
- Every other branch of the handler is byte-identical (no other code changes in
  `TerminalView.tsx`).
- Behavior notes (verified): the mobile toolbar's Esc button
  (`resolveMobileToolbarInput`, `TerminalView.tsx:551`) is an independent `\u001b`
  ingress via `sendInput` and is unaffected. Going through `onData` adds the same
  side effects arrows already have: pane tab-recency + throttled session-activity
  recording, and `isEngagementInput('\x1b')` is false so Escape does not dismiss the
  tab's green attention state (consistent with arrow keys).

**Files:**
- Modify: `src/components/TerminalView.tsx:2429-2440` (delete the 12-line
  plain-Escape interception block between the `isTerminalPasteShortcut` branch and
  the `tabSwitchDirection` branch; nothing else).
- Test: `test/unit/client/components/TerminalView.keyboard.test.tsx` — rewrite the
  test `sends plain Escape directly as terminal input` (line ~878).
- Test: `test/e2e/terminal-paste-single-ingress.test.tsx` — rewrite the test
  `sends plain Escape once as terminal input` (line ~271).

**Interfaces:**
- Consumes: Task 1's spec (the regression guard re-run in Step 6);
  `createKeyboardEvent('Escape')` from the unit test file (returns a mock event with
  `preventDefault: vi.fn()`); the mocks `capturedKeyHandler` / `capturedOnData` (unit)
  and `keyHandler` / `onDataCb` (mocked e2e) captured from the xterm mock.
- Produces: no new interfaces. The removed block frees the handler of Escape
  responsibilities; plain Escape now reaches the final `return true`.

**Test cases:**
- Unit (RED against current code): `capturedKeyHandler(createKeyboardEvent('Escape'))`
  → returns `true`, `preventDefault` NOT called, `wsMocks.send` NOT called; then
  `capturedOnData('\x1b')` → exactly one `wsMocks.send` with
  `{ type: 'terminal.input', terminalId: 'term-1', data: '\u001b' }`.
- Mocked e2e (RED against current code): same shape via `keyHandler` / `onDataCb`:
  handler returns `true`, no preventDefault, no send; `onDataCb('\x1b')` → exactly one
  `wsMocks.send` with the same frame.
- Boundary: the two focus-report strings (`'\u001b[I'`, `'\u001b[O'`) are not confused
  with plain Escape by the onData gate (existing behavior, unchanged).

- [ ] **Step 1: Write the failing tests**

Rewrite the unit test at `test/unit/client/components/TerminalView.keyboard.test.tsx`
(replaces `sends plain Escape directly as terminal input`):

```tsx
it('passes plain Escape through to xterm and sends once via onData', async () => {
  const { store, tabId, paneId, paneContent } = createTestStore('term-1')

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => {
    expect(capturedKeyHandler).not.toBeNull()
    expect(capturedOnData).not.toBeNull()
  })

  const wsSendCountBefore = wsMocks.send.mock.calls.length
  const event = createKeyboardEvent('Escape')
  const result = capturedKeyHandler!(event)

  expect(result).toBe(true)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(wsMocks.send).toHaveBeenCalledTimes(wsSendCountBefore)

  capturedOnData!('\x1b')

  expect(wsMocks.send).toHaveBeenCalledTimes(wsSendCountBefore + 1)
  expect(wsMocks.send).toHaveBeenLastCalledWith({
    type: 'terminal.input',
    terminalId: 'term-1',
    data: '\u001b',
  })
})
```

Rewrite the mocked e2e test at
`test/e2e/terminal-paste-single-ingress.test.tsx` (replaces `sends plain Escape once
as terminal input`):

```tsx
it('sends plain Escape once as terminal input via onData', async () => {
  const store = createStore()
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-1',
    initialCwd: '/tmp',
  }

  render(
    <Provider store={store}>
      <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => {
    expect(keyHandler).not.toBeNull()
  })
  await waitFor(() => {
    expect(onDataCb).not.toBeNull()
  })

  wsMocks.send.mockClear()
  const preventDefault = vi.fn()
  const passed = keyHandler!({
    key: 'Escape',
    code: 'Escape',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    type: 'keydown',
    repeat: false,
    preventDefault,
  } as unknown as KeyboardEvent)

  expect(passed).toBe(true)
  expect(preventDefault).not.toHaveBeenCalled()
  expect(wsMocks.send).not.toHaveBeenCalled()

  onDataCb!('\x1b')

  expect(wsMocks.send).toHaveBeenCalledTimes(1)
  expect(wsMocks.send).toHaveBeenCalledWith({
    type: 'terminal.input',
    terminalId: 'term-1',
    data: '\u001b',
  })
})
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/TerminalView.keyboard.test.tsx
npm run test:vitest -- run test/e2e/terminal-paste-single-ingress.test.tsx
```

Expected: both rewritten Escape tests FAIL because the current custom handler
intercepts plain Escape (`result` is `false`, `preventDefault` called, direct send
happens). All other tests in both files PASS.

- [ ] **Step 3: Remove the interception**

In `src/components/TerminalView.tsx`, delete exactly this block (currently
lines 2429-2440):

```ts
      if (
        event.key === 'Escape' &&
        event.type === 'keydown' &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault()
        sendInput('\u001b')
        return false
      }
```

No other production change.

- [ ] **Step 4: Run the focused tests**

Run: same two commands as Step 2.

Expected: PASS (both files, all tests).

- [ ] **Step 5: Refactor while green**

No refactor needed: the change is a pure deletion; `sendInput` remains used by the
`onData` handler and the Shift+Enter branch. Confirm no unused imports/lints appear.

- [ ] **Step 6: Run broader verification**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/TerminalView.keyboard.test.tsx test/e2e/terminal-paste-single-ingress.test.tsx test/unit/client/components/terminal/
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium terminal-escape-key-rust
```

Expected: PASS. The Playwright re-run is the June-regression guard: after removal,
real xterm key evaluation must still deliver the single `\u001b` frame. If it FAILS,
STOP: the interception was load-bearing for real-xterm delivery — revert the removal,
record the evidence, and escalate for replanning (do not weaken the spec).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.keyboard.test.tsx test/e2e/terminal-paste-single-ingress.test.tsx
git commit -m "fix(terminal): route plain Escape through xterm's normal key pipeline"
```

### Task 3: Complete verification

**Requirements served:** R1, R2, R3

**Behavior:** The full repo-supported verification passes on the final committed HEAD:
typecheck, lint, the coordinated full vitest suite (default + server configs), and the
cloud e2e backend run including the new spec (not skipped).

**Files:** none (verification only).

**Test cases:**
- `npm run check` → exit 0 (typecheck + coordinated full suite).
- `npm run lint` → exit 0.
- `npm run test:e2e` (cloud) → exit 0, and the run output shows
  `terminal-escape-key-rust.spec.ts` executed and passed (a spec sitting in a skip list
  or a filter matching no tests is not coverage — verify the spec appears in the
  results).

- [ ] **Step 1: Run `npm run check`** (through the coordinator gate; set
  `FRESHELL_TEST_SUMMARY="the-usual terminal-escape-input final verification"`)

Expected: exit 0.

- [ ] **Step 2: Run `npm run lint`**

Expected: exit 0.

- [ ] **Step 3: Run `npm run test:e2e`** (cloud backend)

Expected: exit 0 with the new spec present and passing in the results.

- [ ] **Step 4: Record the verification receipt**

Record exact commands, exit codes, test counts, and the verified `HEAD` SHA in the
run's logs directory (verification receipt for the final Fresh Eyes round).
