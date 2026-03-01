# Fix Escape Key Not Interrupting Freshclaude Agent Chat

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Escape key reliably interrupt a running Freshclaude agent chat session, regardless of which element inside the agent-chat pane has focus.

**Architecture:** Move the Escape-to-interrupt handler from the `<textarea>` `onKeyDown` in `ChatComposer` up to a container-level `onKeyDown` on the `AgentChatView` wrapper `<div>`. Add `tabIndex={-1}` so the container can receive keyboard events. This scopes the interrupt to the agent-chat pane without affecting other panes (terminals, editors, browsers). The existing `handleContainerPointerUp` already restores focus inside the container on click.

**Tech Stack:** React 18, Vitest, Testing Library, userEvent

**Known issue:** All client-side tests currently fail with `act(...) is not supported in production builds of React` — this is a pre-existing environment issue on main, not caused by our changes. Write tests correctly; verify they are structurally sound even if the runner rejects them.

---

### Task 1: Add container-level Escape handler to AgentChatView

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx:377-378`

**Step 1: Write the failing test**

Create a new test file that verifies the container-level Escape behavior. This tests AgentChatView in isolation with a mocked Redux store and WebSocket client.

Create: `test/unit/client/components/agent-chat/AgentChatView-interrupt.test.tsx`

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import AgentChatView from '../../../../../src/components/agent-chat/AgentChatView'
import agentChatReducer from '../../../../../src/store/agentChatSlice'
import panesReducer from '../../../../../src/store/panesSlice'
import settingsReducer from '../../../../../src/store/settingsSlice'
import type { AgentChatPaneContent } from '../../../../../src/store/paneTypes'

// Mock ws-client to capture sent messages
const mockSend = vi.fn()
vi.mock('../../../../../src/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onReconnect: () => () => {},
  }),
}))

// Mock api
vi.mock('../../../../../src/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

function makeStore(sessionState?: Record<string, unknown>) {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
    preloadedState: sessionState,
  })
}

const basePaneContent: AgentChatPaneContent = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-1',
  sessionId: 'sess-1',
  status: 'running',
}

describe('AgentChatView Escape interrupt', () => {
  beforeEach(() => {
    mockSend.mockClear()
  })
  afterEach(() => {
    cleanup()
  })

  it('sends sdk.interrupt when Escape is pressed on the container while running', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>
    )
    const container = screen.getByRole('region', { name: /chat/i })
    fireEvent.keyDown(container, { key: 'Escape' })
    expect(mockSend).toHaveBeenCalledWith({
      type: 'sdk.interrupt',
      sessionId: 'sess-1',
    })
  })

  it('does not send sdk.interrupt when Escape is pressed while idle', () => {
    const store = makeStore()
    const idleContent = { ...basePaneContent, status: 'idle' as const }
    render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={idleContent} />
      </Provider>
    )
    const container = screen.getByRole('region', { name: /chat/i })
    fireEvent.keyDown(container, { key: 'Escape' })
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sdk.interrupt' })
    )
  })

  it('does not send sdk.interrupt for non-Escape keys while running', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>
    )
    const container = screen.getByRole('region', { name: /chat/i })
    fireEvent.keyDown(container, { key: 'a' })
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sdk.interrupt' })
    )
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/agent-chat/AgentChatView-interrupt.test.tsx`

Expected: FAIL — the container doesn't have `onKeyDown` or `tabIndex` yet, so `fireEvent.keyDown` on the container won't trigger any interrupt. (Note: may also fail with pre-existing React `act()` error.)

**Step 3: Add container-level onKeyDown and tabIndex to AgentChatView**

In `src/components/agent-chat/AgentChatView.tsx`:

1. Add a `handleContainerKeyDown` callback (near line 237, after `handleContainerPointerUp`):

```tsx
const handleContainerKeyDown = useCallback((e: React.KeyboardEvent) => {
  if (e.key === 'Escape' && isRunning) {
    e.preventDefault()
    handleInterrupt()
  }
}, [isRunning, handleInterrupt])
```

Note: `isRunning` is derived at line 305 (`const isRunning = paneContent.status === 'running'`). The callback references `isRunning` and `handleInterrupt`, both of which are defined before the return statement. Place the callback definition after line 305 (after `isRunning` is derived) so the dependency is available.

2. Update the outer `<div>` on line 378 to add `tabIndex={-1}` and `onKeyDown`:

Change:
```tsx
<div className={cn('h-full w-full flex flex-col', hidden ? 'tab-hidden' : 'tab-visible')} role="region" aria-label={`${providerLabel} Chat`} onPointerUp={handleContainerPointerUp}>
```

To:
```tsx
<div className={cn('h-full w-full flex flex-col', hidden ? 'tab-hidden' : 'tab-visible')} role="region" aria-label={`${providerLabel} Chat`} tabIndex={-1} onKeyDown={handleContainerKeyDown} onPointerUp={handleContainerPointerUp}>
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/agent-chat/AgentChatView-interrupt.test.tsx`

Expected: PASS (or pre-existing React act() failure — structurally verify the test is correct)

**Step 5: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx test/unit/client/components/agent-chat/AgentChatView-interrupt.test.tsx
git commit -m "fix: add container-level Escape handler so interrupt works regardless of focus"
```

---

### Task 2: Remove redundant Escape handler from ChatComposer

Now that the container handles Escape, the textarea-level handler is redundant. Remove it to avoid double-firing.

**Files:**
- Modify: `src/components/agent-chat/ChatComposer.tsx:41-44`
- Modify: `src/components/agent-chat/ChatComposer.tsx:9` (props interface)
- Modify: `src/components/agent-chat/ChatComposer.tsx:17` (destructured props)
- Modify: `src/components/agent-chat/ChatComposer.tsx:45` (useCallback deps)
- Modify: `test/unit/client/components/agent-chat/ChatComposer.test.tsx:58-76`

**Step 1: Update the ChatComposer tests**

The two Escape-specific tests in `ChatComposer.test.tsx` (lines 58-76) should be removed since Escape handling is now the container's responsibility (tested in Task 1). The `onInterrupt` prop remains because the Stop button still uses it.

Remove the two tests:
- `'calls onInterrupt when Escape is pressed while running'` (lines 58-66)
- `'does not call onInterrupt when Escape is pressed while not running'` (lines 68-76)

**Step 2: Run tests to verify the removed tests no longer exist**

Run: `npx vitest run test/unit/client/components/agent-chat/ChatComposer.test.tsx`

Expected: 7 tests (down from 9). The stop-button click test still exercises `onInterrupt`.

**Step 3: Remove Escape handling from ChatComposer.tsx**

In `src/components/agent-chat/ChatComposer.tsx`, remove the `isRunning` dependency from `handleKeyDown`:

Change the `handleKeyDown` callback (lines 36-45) from:
```tsx
const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
  if (e.key === 'Escape' && isRunning) {
    e.preventDefault()
    onInterrupt()
  }
}, [handleSend, isRunning, onInterrupt])
```

To:
```tsx
const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}, [handleSend])
```

Also remove `isRunning` from the `ChatComposerProps` interface (line 13) and the destructured props (line 17), since it's no longer needed by ChatComposer. **Keep `onInterrupt`** — it's still used by the Stop button (line 77).

Remove line 13: `isRunning?: boolean`

Update line 17 from:
```tsx
function ChatComposer({ onSend, onInterrupt, disabled, isRunning, placeholder }, ref) {
```
To:
```tsx
function ChatComposer({ onSend, onInterrupt, disabled, placeholder }, ref) {
```

Update the JSX that conditionally renders the Stop button (line 74). It currently checks `isRunning` which we're removing from props. This needs to come from a new prop or we need to keep `isRunning`.

**Wait — reconsider.** `isRunning` is also used on line 74 to toggle between the Stop button and Send button. We need to keep `isRunning` as a prop for that UI toggle. Only remove the Escape handler from `handleKeyDown`, not the `isRunning` prop.

Revised change — just remove the Escape block from `handleKeyDown`:

```tsx
const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}, [handleSend])
```

And remove `isRunning` and `onInterrupt` from the `useCallback` deps since they're no longer referenced in the callback.

**Step 4: Update AgentChatView to stop passing isRunning to ChatComposer for Escape**

No change needed — `AgentChatView` still passes `isRunning` and `onInterrupt` to `ChatComposer` for the Stop button toggle. This is correct.

**Step 5: Run all agent-chat tests**

Run: `npx vitest run test/unit/client/components/agent-chat/`

Expected: All tests pass (structurally correct; may have pre-existing act() failures).

**Step 6: Commit**

```bash
git add src/components/agent-chat/ChatComposer.tsx test/unit/client/components/agent-chat/ChatComposer.test.tsx
git commit -m "refactor: remove redundant Escape handler from ChatComposer textarea"
```

---

### Task 3: Verify no regressions and clean up

**Step 1: Run the full test suite**

Run: `npm test`

Expected: Same pass/fail counts as baseline (no new failures introduced).

**Step 2: Run lint**

Run: `npm run lint`

Expected: No new lint errors. The `tabIndex={-1}` on a `<div>` with `role="region"` and `onKeyDown` is valid per jsx-a11y rules (interactive handlers on focusable elements).

**Step 3: Manual smoke test (if possible)**

If the dev server can be started in the worktree, open Freshclaude, send a prompt that generates a long response, click somewhere in the message area (not the textarea), then press Escape. The generation should stop.

**Step 4: Final commit (if any lint/cleanup needed)**

```bash
git add -A
git commit -m "chore: lint and cleanup"
```
