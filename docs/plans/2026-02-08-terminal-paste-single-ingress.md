# Terminal Paste Single-Ingress Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate double-paste and normalize paste behavior across browsers/OS by enforcing a single terminal input ingress path.

**Architecture:** Treat xterm as the only byte-level input authority. Keyboard handlers in app code become policy-only (allow/block shortcut translation), and all pasted text is injected through xterm’s paste path, then forwarded via a single `term.onData -> ws.send` egress. Avoid server-side dedupe hacks; fix the client architecture instead.

**Tech Stack:** React 18 + Redux Toolkit + xterm.js, TypeScript, Vitest + Testing Library (unit/e2e-in-repo).

---

## Ground Rules

- Work only in a worktree branch.
- TDD for every behavior change (red -> green -> refactor).
- Keep one source of truth for terminal input bytes: `term.onData`.
- No server-side dedupe for paste.

## Problem Statement (Current)

1. `Ctrl+V` path in `src/components/TerminalView.tsx` sends `terminal.input` directly.
2. Native browser paste still reaches xterm paste listeners in many environments.
3. `term.onData` forwards the same paste again.
4. Result: duplicate or environment-dependent paste behavior.
5. Existing tests validate direct-send behavior and miss keydown+paste interaction.

---

### Task 1: Codify Paste Shortcut Policy In Isolation

**Files:**
- Create: `src/lib/terminal-input-policy.ts`
- Create: `test/unit/client/lib/terminal-input-policy.test.ts`

**Step 1: Write failing tests for cross-platform paste shortcut detection**

Add `test/unit/client/lib/terminal-input-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isTerminalPasteShortcut } from '@/lib/terminal-input-policy'

function e(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    type: 'keydown',
    ...partial,
  } as KeyboardEvent
}

describe('isTerminalPasteShortcut', () => {
  it('matches Ctrl+V', () => {
    expect(isTerminalPasteShortcut(e({ ctrlKey: true, key: 'v', code: 'KeyV' }))).toBe(true)
  })

  it('matches Ctrl+Shift+V', () => {
    expect(isTerminalPasteShortcut(e({ ctrlKey: true, shiftKey: true, key: 'V', code: 'KeyV' }))).toBe(true)
  })

  it('matches Meta+V (macOS)', () => {
    expect(isTerminalPasteShortcut(e({ metaKey: true, key: 'v', code: 'KeyV' }))).toBe(true)
  })

  it('matches Shift+Insert', () => {
    expect(isTerminalPasteShortcut(e({ shiftKey: true, key: 'Insert', code: 'Insert' }))).toBe(true)
  })

  it('ignores non-keydown and repeats', () => {
    expect(isTerminalPasteShortcut(e({ ctrlKey: true, key: 'v', code: 'KeyV', type: 'keyup' }))).toBe(false)
    expect(isTerminalPasteShortcut(e({ ctrlKey: true, key: 'v', code: 'KeyV', repeat: true }))).toBe(false)
  })
})
```

**Step 2: Run test to verify red**

Run: `npm test -- test/unit/client/lib/terminal-input-policy.test.ts`

Expected: FAIL (`Cannot find module '@/lib/terminal-input-policy'`).

**Step 3: Implement minimal policy module**

Create `src/lib/terminal-input-policy.ts`:

```ts
export type TerminalShortcutEvent = Pick<KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'type' | 'repeat'>

export function isTerminalPasteShortcut(event: TerminalShortcutEvent): boolean {
  if (event.type !== 'keydown') return false
  if (event.repeat) return false

  const keyV = event.key === 'v' || event.key === 'V' || event.code === 'KeyV'
  const ctrlOrMetaV = keyV && (event.ctrlKey || event.metaKey) && !event.altKey
  const shiftInsert = event.shiftKey && event.code === 'Insert'

  return ctrlOrMetaV || shiftInsert
}
```

**Step 4: Run test to verify green**

Run: `npm test -- test/unit/client/lib/terminal-input-policy.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/terminal-input-policy.ts test/unit/client/lib/terminal-input-policy.test.ts
git commit -m "test(client): codify cross-platform terminal paste shortcut policy"
```

---

### Task 2: Remove Direct Keyboard Paste WS Sends (Single-Ingress)

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.keyboard.test.tsx`

**Step 1: Write failing keyboard behavior tests (no direct paste send)**

In `test/unit/client/components/TerminalView.keyboard.test.tsx`, replace current Ctrl+V/Ctrl+Shift+V expectations with:

```ts
it('Ctrl+V returns false and does not send input directly', async () => {
  const { store, tabId, paneId, paneContent } = createTestStore('term-1')

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => expect(capturedKeyHandler).not.toBeNull())

  const result = capturedKeyHandler!(createKeyboardEvent('v', { ctrlKey: true }))
  expect(result).toBe(false)
  expect(clipboardMocks.readText).not.toHaveBeenCalled()
  expect(wsMocks.send).not.toHaveBeenCalled()
})

it('Cmd+V (Meta+V) returns false and does not send input directly', async () => {
  const { store, tabId, paneId, paneContent } = createTestStore('term-1')

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => expect(capturedKeyHandler).not.toBeNull())

  const result = capturedKeyHandler!(createKeyboardEvent('v', { metaKey: true }))
  expect(result).toBe(false)
  expect(clipboardMocks.readText).not.toHaveBeenCalled()
  expect(wsMocks.send).not.toHaveBeenCalled()
})
```

**Step 2: Run focused keyboard test and verify red**

Run: `npm test -- test/unit/client/components/TerminalView.keyboard.test.tsx -t "does not send input directly"`

Expected: FAIL (current implementation calls `readText` and `ws.send`).

**Step 3: Implement policy-only paste shortcut handling**

In `src/components/TerminalView.tsx`:

- Import policy helper:

```ts
import { isTerminalPasteShortcut } from '@/lib/terminal-input-policy'
```

- Replace current paste keyboard block with:

```ts
if (isTerminalPasteShortcut(event)) {
  // Policy-only: block xterm key translation (e.g., Ctrl+V -> ^V)
  // and allow native paste event path to feed xterm.
  return false
}
```

- Remove direct `readText().then(... ws.send ...)` from keyboard handling.

**Step 4: Run keyboard tests and verify green**

Run: `npm test -- test/unit/client/components/TerminalView.keyboard.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.keyboard.test.tsx
git commit -m "fix(client): make keyboard paste handling policy-only with no direct websocket send"
```

---

### Task 3: Route App Context-Menu Paste Through xterm Paste API

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.keyboard.test.tsx`

**Step 1: Write failing test for terminal actions paste path**

Extend `test/unit/client/components/TerminalView.keyboard.test.tsx` with a controlled xterm mock that captures `onData` callback and exposes `paste` method.

Add a test:

```ts
it('context-menu paste uses term.paste and emits exactly one terminal.input via onData', async () => {
  clipboardMocks.readText.mockResolvedValue('pasted content')
  const { store, tabId, paneId, paneContent } = createTestStore('term-1')

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => expect(capturedTerminal).not.toBeNull())

  const actions = getTerminalActions(paneId)
  expect(actions).toBeDefined()

  await actions!.paste()

  expect(capturedTerminal!.paste).toHaveBeenCalledWith('pasted content')
  expect(wsMocks.send).toHaveBeenCalledTimes(1)
  expect(wsMocks.send).toHaveBeenCalledWith({
    type: 'terminal.input',
    terminalId: 'term-1',
    data: 'pasted content',
  })
})
```

**Step 2: Run focused test to verify red**

Run: `npm test -- test/unit/client/components/TerminalView.keyboard.test.tsx -t "context-menu paste uses term.paste"`

Expected: FAIL (current code sends WS directly and does not call `term.paste`).

**Step 3: Implement context-menu paste via xterm**

In `src/components/TerminalView.tsx`, inside `registerTerminalActions(... paste ...)`:

Replace direct ws send:

```ts
ws.send({ type: 'terminal.input', terminalId: tid, data: text })
```

with:

```ts
term.paste(text)
```

Keep clipboard read as intent source; let xterm emit bytes through existing `onData` path.

**Step 4: Run keyboard/component tests and verify green**

Run: `npm test -- test/unit/client/components/TerminalView.keyboard.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.keyboard.test.tsx
git commit -m "fix(client): route terminal action paste through xterm paste pipeline"
```

---

### Task 4: Add E2E Regression Test For Single-Ingress Invariant

**Files:**
- Create: `test/e2e/terminal-paste-single-ingress.test.tsx`

**Step 1: Write failing e2e test for no-double-send invariant**

Create `test/e2e/terminal-paste-single-ingress.test.tsx` (patterned after existing e2e files):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import TerminalView from '@/components/TerminalView'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

let keyHandler: ((e: KeyboardEvent) => boolean) | null = null
let onDataCb: ((data: string) => void) | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('xterm', () => {
  class MockTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    open = vi.fn()
    loadAddon = vi.fn()
    write = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    dispose = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    onData = vi.fn((cb: (data: string) => void) => { onDataCb = cb })
    attachCustomKeyEventHandler = vi.fn((cb: (e: KeyboardEvent) => boolean) => { keyHandler = cb })
    paste = vi.fn((text: string) => { onDataCb?.(text) })
  }
  return { Terminal: MockTerminal }
})

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class { fit = vi.fn() },
}))

vi.mock('xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createStore() {
  const paneContent = {
    kind: 'terminal' as const,
    createRequestId: 'req-1',
    status: 'running' as const,
    mode: 'shell' as const,
    shell: 'system' as const,
    terminalId: 'term-1',
    initialCwd: '/tmp',
  }
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, settings: settingsReducer, connection: connectionReducer },
    preloadedState: {
      tabs: { tabs: [{ id: 'tab-1', mode: 'shell', status: 'running', title: 'Shell', titleSetByUser: false, createRequestId: 'req-1', terminalId: 'term-1' }], activeTabId: 'tab-1' },
      panes: { layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: paneContent } }, activePane: { 'tab-1': 'pane-1' }, paneTitles: {} },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null },
    },
  })
}

describe('terminal paste single-ingress (e2e)', () => {
  beforeEach(() => {
    wsMocks.send.mockClear()
    keyHandler = null
    onDataCb = null
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('does not send on keydown paste shortcut; sends once when xterm emits data', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={{ kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell', shell: 'system', terminalId: 'term-1', initialCwd: '/tmp' }} />
      </Provider>
    )

    await waitFor(() => expect(keyHandler).not.toBeNull())
    await waitFor(() => expect(onDataCb).not.toBeNull())

    const blocked = keyHandler!({ key: 'v', code: 'KeyV', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, type: 'keydown', repeat: false } as KeyboardEvent)
    expect(blocked).toBe(false)
    expect(wsMocks.send).toHaveBeenCalledTimes(0)

    onDataCb!('paste payload')

    expect(wsMocks.send).toHaveBeenCalledTimes(1)
    expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.input', terminalId: 'term-1', data: 'paste payload' })
  })
})
```

**Step 2: Run e2e test to verify red**

Run: `npm test -- test/e2e/terminal-paste-single-ingress.test.tsx`

Expected: FAIL before Tasks 2-3 are complete.

**Step 3: Re-run after implementation; verify green**

Run: `npm test -- test/e2e/terminal-paste-single-ingress.test.tsx`

Expected: PASS.

**Step 4: Commit**

```bash
git add test/e2e/terminal-paste-single-ingress.test.tsx
git commit -m "test(e2e): add single-ingress paste regression coverage for terminal input"
```

---

### Task 5: Refactor For Readability (No Behavior Change)

**Files:**
- Modify: `src/components/TerminalView.tsx`

**Step 1: Extract small internal helpers in TerminalView**

Refactor to reduce paste/input duplication risk:

```ts
const sendInput = useCallback((data: string) => {
  const tid = terminalIdRef.current
  if (!tid) return
  ws.send({ type: 'terminal.input', terminalId: tid, data })
}, [ws])
```

Use `sendInput(data)` from `term.onData` only.

**Step 2: Keep keyboard path policy-only**

```ts
if (isTerminalPasteShortcut(event)) {
  return false
}
```

No clipboard reads, no ws sends in key handler.

**Step 3: Run targeted tests**

Run:
- `npm test -- test/unit/client/components/TerminalView.keyboard.test.tsx`
- `npm test -- test/e2e/terminal-paste-single-ingress.test.tsx`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/components/TerminalView.tsx
git commit -m "refactor(client): centralize terminal input send path through onData"
```

---

### Task 6: Full Validation And Cross-Environment Matrix

**Files:**
- No code changes required unless failures found.

**Step 1: Run complete automated suite before merge**

Run: `npm test`

Expected: PASS.

**Step 2: Manual verification matrix (required)**

Validate these scenarios in real browsers/devices (at least one from each row):

1. Chrome on Linux/Windows, `http://localhost`.
2. Chrome on Linux/Windows, `http://<LAN-IP>`.
3. Firefox on Linux/Windows, `http://localhost`.
4. Safari on macOS, `http://localhost`.
5. macOS `Cmd+V` in terminal pane.
6. Linux middle-click paste in terminal pane.
7. Context menu -> Paste in terminal pane.
8. Multi-line paste into shell with bracketed-paste-aware tool.

For each scenario, assert:
- Pasted payload appears exactly once.
- No `^V` literal appears for keyboard paste shortcuts.
- Multi-line paste preserves expected shell behavior.

**Step 3: If matrix reveals an environment-specific bug, add test first**

- Add failing unit/e2e coverage for that exact environment behavior.
- Implement minimal fix.
- Re-run full matrix item and automated tests.

**Step 4: Final commit (if any matrix-driven code/test updates)**

```bash
git add <changed-files>
git commit -m "fix(client): harden terminal paste behavior for <environment>"
```

---

## Merge Readiness Checklist

- [ ] No direct paste `ws.send` remains in `src/components/TerminalView.tsx` keyboard/context-menu paths.
- [ ] `term.onData` is the only byte egress to `terminal.input`.
- [ ] Unit tests for paste shortcut policy pass.
- [ ] TerminalView keyboard/action tests pass.
- [ ] E2E single-ingress regression test passes.
- [ ] `npm test` passes.
- [ ] Manual browser/OS matrix completed and logged.

