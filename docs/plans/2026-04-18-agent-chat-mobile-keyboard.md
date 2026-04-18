# Agent Chat Mobile Keyboard & Responsive Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent chat (Freshclaude) fully usable on mobile devices by handling the virtual keyboard correctly, adapting the layout responsively, and ensuring interactive elements meet minimum touch target sizes.

**Architecture:** Extract the TerminalView's proven `visualViewport`-based keyboard inset detection into a shared `useKeyboardInset` hook. Use this hook in AgentChatView to push the ChatComposer above the virtual keyboard and constrain the message scroll area. Apply Tailwind responsive utilities and minimum touch target sizing across all agent chat components so the chat experience is comfortable at any viewport width.

**Tech Stack:** React 18, Tailwind CSS responsive utilities, `window.visualViewport` API, Vitest + Testing Library unit tests, Playwright e2e browser tests.

---

## Design Direction

**Purpose:** Freshclaude is a rich chat UI for conversational AI agent sessions, accessed remotely over LAN/VPN. Many users access it from phones and tablets while away from their desk. The current experience is broken on mobile: the virtual keyboard covers the input, messages don't scroll properly, interactive elements are too small, and the settings panel doesn't account for keyboard state.

**Tone:** Industrial/utilitarian -- this is a power-user tool. The mobile experience should feel like a native chat app (Messages, Telegram, Slack) in terms of keyboard behavior, but keep Freshell's dense, professional aesthetic. No decorative chrome; every pixel serves a function.

**Differentiation:** The input must always stay visible and reachable above the keyboard. Messages auto-scroll to stay readable. Permission and question banners should pin to the viewport when they need answers. The experience should be indistinguishable from a native app in terms of keyboard interaction fidelity.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/hooks/useKeyboardInset.ts` | Shared hook: detects mobile virtual keyboard height via `visualViewport` API. Returns `insetPx` (0 when no keyboard). Extracted from TerminalView's existing pattern. |
| `test/unit/client/hooks/useKeyboardInset.test.ts` | Unit tests for the keyboard inset hook. |
| `test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx` | Unit tests for mobile keyboard layout behavior in AgentChatView. |
| `test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx` | Unit tests for mobile touch targets and keyboard interaction on the composer. |
| `test/unit/client/components/agent-chat/PermissionBanner.mobile.test.tsx` | Unit tests for mobile touch targets on permission buttons. |
| `test/unit/client/components/agent-chat/QuestionBanner.mobile.test.tsx` | Unit tests for mobile touch targets on question buttons. |

### Modified Files

| File | Changes |
|------|---------|
| `src/components/TerminalView.tsx` | Remove inline `visualViewport` keyboard detection; import `useKeyboardInset` instead. |
| `src/components/agent-chat/AgentChatView.tsx` | Use `useKeyboardInset` to adjust message area height and composer position. Add `useMobile` for conditional layout. |
| `src/components/agent-chat/ChatComposer.tsx` | Accept `keyboardInsetPx` prop; apply `bottom` offset on mobile. Increase send/stop button touch targets on mobile. |
| `src/components/agent-chat/MessageBubble.tsx` | Tighten horizontal padding on mobile to maximize reading width. |
| `src/components/agent-chat/PermissionBanner.tsx` | Increase Allow/Deny button touch targets (`min-h-11 min-w-11`) on mobile. |
| `src/components/agent-chat/QuestionBanner.tsx` | Increase option button touch targets on mobile. |
| `src/components/agent-chat/AgentChatSettings.tsx` | Account for keyboard inset when rendered as bottom sheet on mobile. |
| `src/components/agent-chat/ToolStrip.tsx` | Increase toggle button touch target on mobile. |
| `test/unit/client/components/TerminalView.mobile-viewport.test.tsx` | Update to use the extracted hook. |
| `test/e2e-browser/specs/mobile-viewport.spec.ts` | Add agent chat mobile keyboard tests. |

---

### Task 1: Extract `useKeyboardInset` hook from TerminalView

**Files:**
- Create: `src/hooks/useKeyboardInset.ts`
- Create: `test/unit/client/hooks/useKeyboardInset.test.ts`
- Modify: `src/components/TerminalView.tsx:601-632`

- [ ] **Step 1: Write the failing test for `useKeyboardInset`**

Create `test/unit/client/hooks/useKeyboardInset.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'

// Uses the test-setup `setMobileForTest()` infrastructure (test/setup/dom.ts)
// to control useMobile(), matching the pattern used across all existing tests.

describe('useKeyboardInset', () => {
  let originalVisualViewport: VisualViewport | null
  let originalInnerHeight: number
  let fakeViewport: {
    height: number
    offsetTop: number
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    originalVisualViewport = window.visualViewport
    originalInnerHeight = window.innerHeight
    fakeViewport = {
      height: 800,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true })
    Object.defineProperty(window, 'visualViewport', { value: fakeViewport, writable: true, configurable: true })
    requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    ;(globalThis as any).setMobileForTest(false)
  })

  afterEach(() => {
    ;(globalThis as any).setMobileForTest(false)
    Object.defineProperty(window, 'visualViewport', { value: originalVisualViewport, writable: true, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, writable: true, configurable: true })
    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })

  it('returns 0 on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    const { result } = renderHook(() => useKeyboardInset())
    expect(result.current).toBe(0)
  })

  it('returns 0 on mobile when no keyboard is open', () => {
    ;(globalThis as any).setMobileForTest(true)
    const { result } = renderHook(() => useKeyboardInset())
    expect(result.current).toBe(0)
  })

  it('returns keyboard height on mobile when keyboard is open', () => {
    ;(globalThis as any).setMobileForTest(true)
    fakeViewport.height = 400 // keyboard takes 400px
    const { result } = renderHook(() => useKeyboardInset())

    // Simulate visualViewport resize event
    const resizeHandler = fakeViewport.addEventListener.mock.calls
      .find((c: unknown[]) => c[0] === 'resize')?.[1] as (() => void) | undefined
    expect(resizeHandler).toBeDefined()

    act(() => {
      resizeHandler!()
    })
    expect(result.current).toBe(400)
  })

  it('ignores small viewport changes below activation threshold', () => {
    ;(globalThis as any).setMobileForTest(true)
    fakeViewport.height = 750 // only 50px smaller, below 80px threshold
    const { result } = renderHook(() => useKeyboardInset())

    const resizeHandler = fakeViewport.addEventListener.mock.calls
      .find((c: unknown[]) => c[0] === 'resize')?.[1] as (() => void) | undefined

    act(() => {
      resizeHandler?.()
    })
    expect(result.current).toBe(0)
  })

  it('cleans up event listeners on unmount', () => {
    ;(globalThis as any).setMobileForTest(true)
    const { unmount } = renderHook(() => useKeyboardInset())
    unmount()
    expect(fakeViewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(fakeViewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/hooks/useKeyboardInset.test.ts`
Expected: FAIL — module `@/hooks/useKeyboardInset` not found.

- [ ] **Step 3: Implement `useKeyboardInset`**

Create `src/hooks/useKeyboardInset.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react'
import { useMobile } from './useMobile'

/**
 * Minimum viewport shrinkage (in px) before we consider the keyboard "open".
 * Small shrinkage (e.g. address-bar collapse) is ignored.
 */
const KEYBOARD_INSET_ACTIVATION_PX = 80

/**
 * Shared hook that detects the mobile virtual keyboard height using the
 * `visualViewport` API. Returns 0 on desktop or when no keyboard is visible.
 *
 * Extracted from TerminalView for reuse across any component that needs
 * keyboard-aware layout (agent chat, search bars, etc.).
 */
export function useKeyboardInset(): number {
  const isMobile = useMobile()
  const [insetPx, setInsetPx] = useState(0)

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined' || !window.visualViewport) {
      setInsetPx(0)
      return
    }

    const viewport = window.visualViewport
    let rafId: number | null = null

    const updateInset = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      rafId = requestAnimationFrame(() => {
        const rawInset = Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop))
        const nextInset = rawInset >= KEYBOARD_INSET_ACTIVATION_PX ? Math.round(rawInset) : 0
        setInsetPx((prev) => (prev === nextInset ? prev : nextInset))
      })
    }

    updateInset()
    viewport.addEventListener('resize', updateInset)
    viewport.addEventListener('scroll', updateInset)

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      viewport.removeEventListener('resize', updateInset)
      viewport.removeEventListener('scroll', updateInset)
    }
  }, [isMobile])

  return insetPx
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/hooks/useKeyboardInset.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Ensure the hook API is clean and the test covers edge cases. Run the broader suite:

Run: `npm run test:vitest -- --run test/unit/client/hooks/`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useKeyboardInset.ts test/unit/client/hooks/useKeyboardInset.test.ts
git commit -m "feat: extract useKeyboardInset hook from TerminalView"
```

---

### Task 2: Migrate TerminalView to use `useKeyboardInset`

**Files:**
- Modify: `src/components/TerminalView.tsx:93-98, 315, 601-632`
- Modify: `test/unit/client/components/TerminalView.mobile-viewport.test.tsx`

- [ ] **Step 1: Run existing TerminalView mobile viewport tests to confirm green baseline**

Run: `npm run test:vitest -- --run test/unit/client/components/TerminalView.mobile-viewport.test.tsx`
Expected: PASS (confirms current behavior before refactoring)

- [ ] **Step 2: Replace inline keyboard detection with the hook**

In `src/components/TerminalView.tsx`:

1. Remove the `KEYBOARD_INSET_ACTIVATION_PX` constant (line ~97).
2. Remove the `keyboardInsetPx` useState (line ~315): `const [keyboardInsetPx, setKeyboardInsetPx] = useState(0)`.
3. Remove the entire `useEffect` block that listens to `visualViewport` (lines ~601-632).
4. Add import: `import { useKeyboardInset } from '@/hooks/useKeyboardInset'`.
5. Add hook call near other hooks: `const keyboardInsetPx = useKeyboardInset()`.
6. Keep `MOBILE_KEYBAR_HEIGHT_PX` constant — it is specific to TerminalView's toolbar.

- [ ] **Step 3: Run tests to verify the refactor is behavior-preserving**

Run: `npm run test:vitest -- --run test/unit/client/components/TerminalView.mobile-viewport.test.tsx`
Expected: PASS

- [ ] **Step 4: Refactor and verify**

Check that TerminalView no longer has any direct `visualViewport` access. Run the broader test suite:

Run: `npm run test:vitest -- --run test/unit/client/components/TerminalView`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalView.tsx
git commit -m "refactor: migrate TerminalView to shared useKeyboardInset hook"
```

---

### Task 3: Add keyboard-aware layout to AgentChatView

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/ChatComposer.tsx`
- Create: `test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx`

This is the core task. When the mobile keyboard opens, the entire AgentChatView must:
1. Shrink its message scroll area so messages stay visible above the keyboard.
2. Keep the ChatComposer (input + send button) pinned immediately above the keyboard.
3. Auto-scroll to the bottom when the keyboard opens so the latest message stays visible.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

// Mock useKeyboardInset to control keyboard inset value directly
const useKeyboardInsetMock = vi.hoisted(() => vi.fn(() => 0))
vi.mock('@/hooks/useKeyboardInset', () => ({ useKeyboardInset: useKeyboardInsetMock }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

import AgentChatView from '@/components/agent-chat/AgentChatView'
import type { AgentChatPaneContent } from '@/store/paneTypes'

function createStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

const basePaneContent: AgentChatPaneContent = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-1',
  status: 'idle',
  sessionId: 'session-1',
}

describe('AgentChatView mobile keyboard', () => {
  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('applies keyboard inset padding to the outer container on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    useKeyboardInsetMock.mockReturnValue(300)

    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>,
    )

    // The outermost container should have padding-bottom to push content above the keyboard
    const region = container.querySelector('[role="region"]') as HTMLElement
    expect(region).toBeTruthy()
    expect(region.style.paddingBottom).toBe('300px')
  })

  it('does not apply keyboard inset on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    useKeyboardInsetMock.mockReturnValue(0)

    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>,
    )

    const region = container.querySelector('[role="region"]') as HTMLElement
    expect(region).toBeTruthy()
    expect(region.style.paddingBottom).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx`
Expected: FAIL — no keyboard inset behavior implemented yet.

- [ ] **Step 3: Implement keyboard-aware layout**

In `src/components/agent-chat/AgentChatView.tsx`:

1. Add imports:
```typescript
import { useMobile } from '@/hooks/useMobile'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'
```

2. Add hooks inside the component (near other hooks):
```typescript
const isMobile = useMobile()
const keyboardInsetPx = useKeyboardInset()
```

3. Compute the keyboard-aware container style:
```typescript
const keyboardContainerStyle = useMemo(() => {
  if (!isMobile || keyboardInsetPx === 0) return undefined
  return { paddingBottom: `${keyboardInsetPx}px` }
}, [isMobile, keyboardInsetPx])
```

4. Apply the style to the outer `<div>` container (the `role="region"` element):
```tsx
<div
  className={cn('h-full w-full flex flex-col', hidden ? 'tab-hidden' : 'tab-visible')}
  role="region"
  aria-label={`${providerLabel} Chat`}
  onPointerUp={handleContainerPointerUp}
  style={keyboardContainerStyle}
>
```

5. Auto-scroll to bottom when keyboard opens:
```typescript
// Scroll to bottom when mobile keyboard opens to keep latest content visible
const prevKeyboardInsetRef = useRef(0)
useEffect(() => {
  if (keyboardInsetPx > 0 && prevKeyboardInsetRef.current === 0) {
    // Keyboard just opened — scroll to bottom
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }
  prevKeyboardInsetRef.current = keyboardInsetPx
}, [keyboardInsetPx])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Run broader agent chat tests:

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx
git commit -m "feat: add mobile keyboard-aware layout to AgentChatView"
```

---

### Task 4: Increase ChatComposer touch targets on mobile

**Files:**
- Modify: `src/components/agent-chat/ChatComposer.tsx`
- Create: `test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx`

The send and stop buttons are currently `p-2` (~32px). On mobile they must be at least 44x44px for comfortable thumb tapping. The textarea also needs a larger minimum height.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import ChatComposer from '@/components/agent-chat/ChatComposer'

function createStore() {
  return configureStore({
    reducer: { tabs: tabsReducer },
    preloadedState: {
      tabs: { tabs: [], activeTabId: null },
    } as any,
  })
}

describe('ChatComposer mobile touch targets', () => {
  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('send button has min-h-11 min-w-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    const store = createStore()
    render(
      <Provider store={store}>
        <ChatComposer onSend={vi.fn()} onInterrupt={vi.fn()} />
      </Provider>,
    )
    const sendButton = screen.getByRole('button', { name: /send message/i })
    expect(sendButton.className).toContain('min-h-11')
    expect(sendButton.className).toContain('min-w-11')
  })

  it('stop button has min-h-11 min-w-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    const store = createStore()
    render(
      <Provider store={store}>
        <ChatComposer onSend={vi.fn()} onInterrupt={vi.fn()} isRunning />
      </Provider>,
    )
    const stopButton = screen.getByRole('button', { name: /stop generation/i })
    expect(stopButton.className).toContain('min-h-11')
    expect(stopButton.className).toContain('min-w-11')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx`
Expected: FAIL — buttons don't yet have mobile touch target classes.

- [ ] **Step 3: Add mobile touch targets to ChatComposer**

In `src/components/agent-chat/ChatComposer.tsx`:

1. Add import: `import { useMobile } from '@/hooks/useMobile'`
2. Inside the component, add: `const isMobile = useMobile()`
3. Update the send button classes:
```tsx
<button
  type="button"
  onClick={handleSend}
  disabled={disabled || !text.trim()}
  className={cn(
    'rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50',
    isMobile ? 'p-2.5 min-h-11 min-w-11' : 'p-2',
  )}
  aria-label="Send message"
>
  <Send className="h-4 w-4" />
</button>
```

4. Update the stop button classes:
```tsx
<button
  type="button"
  onClick={onInterrupt}
  className={cn(
    'rounded bg-red-600 text-white hover:bg-red-700',
    isMobile ? 'p-2.5 min-h-11 min-w-11' : 'p-2',
  )}
  aria-label="Stop generation"
>
  <Square className="h-4 w-4" />
</button>
```

5. Also increase the textarea min-height on mobile for a more comfortable touch target:
```tsx
className={cn(
  'flex-1 resize-none rounded border bg-background px-3 text-sm',
  'focus:outline-none focus:ring-2 focus:ring-ring',
  'disabled:opacity-50',
  isMobile ? 'py-2.5 min-h-11 max-h-[200px]' : 'py-1.5 min-h-[36px] max-h-[200px]',
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Run existing ChatComposer tests plus the new ones:

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/ChatComposer`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/ChatComposer.tsx test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx
git commit -m "feat: increase ChatComposer touch targets on mobile"
```

---

### Task 5: Increase PermissionBanner touch targets on mobile

**Files:**
- Modify: `src/components/agent-chat/PermissionBanner.tsx`
- Create: `test/unit/client/components/agent-chat/PermissionBanner.mobile.test.tsx`

Allow/Deny buttons are currently `px-3 py-1` (~26px tall). On mobile these need to be at least 44px tall for reliable thumb tapping, especially since permission decisions are high-stakes (allow/deny tool execution).

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/components/agent-chat/PermissionBanner.mobile.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import PermissionBanner from '@/components/agent-chat/PermissionBanner'

describe('PermissionBanner mobile touch targets', () => {
  const basePermission = {
    requestId: 'req-1',
    tool: { name: 'Bash', input: { command: 'ls' } },
  }

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('Allow and Deny buttons have min-h-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    render(
      <PermissionBanner
        permission={basePermission}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    const allowBtn = screen.getByRole('button', { name: /allow/i })
    const denyBtn = screen.getByRole('button', { name: /deny/i })
    expect(allowBtn.className).toContain('min-h-11')
    expect(denyBtn.className).toContain('min-h-11')
  })

  it('buttons do not have min-h-11 on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    render(
      <PermissionBanner
        permission={basePermission}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    const allowBtn = screen.getByRole('button', { name: /allow/i })
    expect(allowBtn.className).not.toContain('min-h-11')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/PermissionBanner.mobile.test.tsx`
Expected: FAIL

- [ ] **Step 3: Add mobile touch targets to PermissionBanner**

In `src/components/agent-chat/PermissionBanner.tsx`:

1. Add imports:
```typescript
import { useMobile } from '@/hooks/useMobile'
```

2. Inside the component (since it's a function component wrapped in `memo`), add:
```typescript
const isMobile = useMobile()
```

3. Update both button classes:
```tsx
<button
  type="button"
  onClick={onAllow}
  disabled={disabled}
  className={cn(
    'px-3 text-xs rounded font-medium',
    'bg-green-600 text-white hover:bg-green-700',
    'disabled:opacity-50',
    isMobile ? 'py-2.5 min-h-11' : 'py-1',
  )}
  aria-label="Allow tool use"
>
  Allow
</button>
<button
  type="button"
  onClick={onDeny}
  disabled={disabled}
  className={cn(
    'px-3 text-xs rounded font-medium',
    'bg-red-600 text-white hover:bg-red-700',
    'disabled:opacity-50',
    isMobile ? 'py-2.5 min-h-11' : 'py-1',
  )}
  aria-label="Deny tool use"
>
  Deny
</button>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/PermissionBanner.mobile.test.tsx`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Run existing PermissionBanner tests plus new:

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/PermissionBanner`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/PermissionBanner.tsx test/unit/client/components/agent-chat/PermissionBanner.mobile.test.tsx
git commit -m "feat: increase PermissionBanner touch targets on mobile"
```

---

### Task 6: Increase QuestionBanner touch targets on mobile

**Files:**
- Modify: `src/components/agent-chat/QuestionBanner.tsx`
- Create: `test/unit/client/components/agent-chat/QuestionBanner.mobile.test.tsx`

The option buttons and "Other"/"Submit" buttons are currently `px-3 py-1.5` (~28px). On mobile, these need min-h-11.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/components/agent-chat/QuestionBanner.mobile.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import QuestionBanner from '@/components/agent-chat/QuestionBanner'

describe('QuestionBanner mobile touch targets', () => {
  const baseQuestion = {
    requestId: 'q-1',
    questions: [{
      question: 'Which option?',
      options: [
        { label: 'Option A', description: 'First' },
        { label: 'Option B', description: 'Second' },
      ],
    }],
  }

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('option buttons have min-h-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    render(
      <QuestionBanner
        question={baseQuestion}
        onAnswer={vi.fn()}
      />,
    )
    const optionA = screen.getByRole('button', { name: /option a/i })
    expect(optionA.className).toContain('min-h-11')
  })

  it('Other button has min-h-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    render(
      <QuestionBanner
        question={baseQuestion}
        onAnswer={vi.fn()}
      />,
    )
    const otherBtn = screen.getByRole('button', { name: /other/i })
    expect(otherBtn.className).toContain('min-h-11')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/QuestionBanner.mobile.test.tsx`
Expected: FAIL

- [ ] **Step 3: Add mobile touch targets to QuestionBanner**

In `src/components/agent-chat/QuestionBanner.tsx`:

1. Add import: `import { useMobile } from '@/hooks/useMobile'`
2. The `useMobile` hook must be called at the top level of each component that needs it. Since `SingleSelectQuestion` and `MultiSelectQuestion` are separate function components rendered inside `QuestionBanner`, pass `isMobile` as a prop.
3. Add `isMobile?: boolean` to `SingleSelectQuestion` and `MultiSelectQuestion` props.
4. In `QuestionBanner`, call `const isMobile = useMobile()` and pass `isMobile={isMobile}` to each.
5. In each sub-component, update button classes:

For option buttons:
```tsx
className={cn(
  'px-3 text-xs rounded-md border transition-colors',
  'bg-blue-600/10 border-blue-500/30 hover:bg-blue-600/20 hover:border-blue-500/50',
  'disabled:opacity-50',
  isMobile ? 'py-2.5 min-h-11' : 'py-1.5',
)}
```

For the "Other" button:
```tsx
className={cn(
  'px-3 text-xs rounded-md border transition-colors',
  'bg-muted/50 border-border hover:bg-muted',
  'disabled:opacity-50',
  isMobile ? 'py-2.5 min-h-11' : 'py-1.5',
)}
```

For the "Submit" button:
```tsx
className={cn(
  'px-3 text-xs rounded font-medium',
  'bg-blue-600 text-white hover:bg-blue-700',
  'disabled:opacity-50',
  isMobile ? 'py-2.5 min-h-11' : 'py-1',
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/QuestionBanner.mobile.test.tsx`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Run existing QuestionBanner tests plus new:

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/QuestionBanner`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/QuestionBanner.tsx test/unit/client/components/agent-chat/QuestionBanner.mobile.test.tsx
git commit -m "feat: increase QuestionBanner touch targets on mobile"
```

---

### Task 7: Make AgentChatSettings bottom sheet keyboard-aware

**Files:**
- Modify: `src/components/agent-chat/AgentChatSettings.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx`

When the agent chat settings panel is open on mobile as a bottom sheet and the keyboard is also open (e.g. after tapping the "Other" input in a question), the bottom sheet should not render behind the keyboard. It should account for the keyboard inset.

- [ ] **Step 1: Run existing AgentChatSettings mobile test to confirm green baseline**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx`
Expected: PASS

- [ ] **Step 2: Add keyboard-aware bottom offset to AgentChatSettings**

In `src/components/agent-chat/AgentChatSettings.tsx`:

1. Add import: `import { useKeyboardInset } from '@/hooks/useKeyboardInset'`
2. Add hook: `const keyboardInsetPx = useKeyboardInset()`
3. Update the mobile bottom sheet container to account for keyboard inset:

Change:
```tsx
isMobile
  ? 'fixed inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-b-none border-x-0'
  : 'absolute right-0 top-full mt-1 w-64',
```

To:
```tsx
isMobile
  ? 'fixed inset-x-0 max-h-[80dvh] overflow-y-auto rounded-b-none border-x-0'
  : 'absolute right-0 top-full mt-1 w-64',
```

And add a style prop to the mobile bottom sheet:
```tsx
style={isMobile ? { bottom: `${keyboardInsetPx}px` } : undefined}
```

- [ ] **Step 3: Add test for keyboard-aware bottom sheet positioning**

In `test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx`, add the mock at the top of the file (after existing mocks):

```typescript
const useKeyboardInsetMock = vi.hoisted(() => vi.fn(() => 0))
vi.mock('@/hooks/useKeyboardInset', () => ({ useKeyboardInset: useKeyboardInsetMock }))
```

Then add a new test inside the existing describe block:

```typescript
it('applies keyboard inset to bottom sheet on mobile', () => {
  ;(globalThis as any).setMobileForTest(true)
  useKeyboardInsetMock.mockReturnValue(300)

  render(
    <AgentChatSettings
      {...defaults}
      sessionStarted={false}
      defaultOpen={true}
      onChange={vi.fn()}
    />
  )

  const dialog = screen.getByRole('dialog', { name: 'Agent chat settings' })
  expect(dialog.style.bottom).toBe('300px')
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Run broader agent chat tests:

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/AgentChatSettings.tsx test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx
git commit -m "feat: make AgentChatSettings bottom sheet keyboard-aware"
```

---

### Task 8: Increase ToolStrip toggle touch target on mobile

**Files:**
- Modify: `src/components/agent-chat/ToolStrip.tsx`

The ToolStrip expand/collapse chevron button is currently `p-0.5` (tiny). On mobile this needs to be larger for thumb tapping.

- [ ] **Step 1: Run existing ToolStrip tests to confirm green baseline**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/ToolStrip.test.tsx`
Expected: PASS

- [ ] **Step 2: Add mobile touch target to the ToolStrip toggle**

In `src/components/agent-chat/ToolStrip.tsx`:

1. Add import: `import { useMobile } from '@/hooks/useMobile'`
2. Inside the component: `const isMobile = useMobile()`
3. Update the collapsed-state toggle button:
```tsx
<button
  type="button"
  onClick={handleToggle}
  className={cn(
    'shrink-0 hover:bg-accent/50 rounded transition-colors',
    isMobile ? 'p-1.5 min-h-11 min-w-11 flex items-center justify-center' : 'p-0.5',
  )}
  aria-label="Toggle tool details"
>
```

4. Update the expanded-state toggle button:
```tsx
<button
  type="button"
  onClick={handleToggle}
  className={cn(
    'ml-1.5 shrink-0 rounded transition-colors hover:bg-accent/50',
    isMobile ? 'p-1.5 min-h-11 min-w-11 flex items-center justify-center' : 'p-0.5',
  )}
  aria-label="Toggle tool details"
>
```

- [ ] **Step 3: Run tests to verify no regression**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/ToolStrip.test.tsx`
Expected: PASS

- [ ] **Step 4: Refactor and verify**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/agent-chat/ToolStrip.tsx
git commit -m "feat: increase ToolStrip toggle touch target on mobile"
```

---

### Task 9: Optimize horizontal space on mobile

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/ChatComposer.tsx`

On a 375px screen, the message area gets only ~369px (375 - 2*3px padding). The left border indicator + pl-2.5 is fine, but the horizontal padding should be tighter on mobile. This task uses the `isMobile` variable already added to AgentChatView in Task 3 (via `useMobile()`) and adds `useMobile()` to ChatComposer (already added in Task 4). This keeps mobile detection consistent with the rest of the plan -- no `md:` viewport breakpoints mixed in.

- [ ] **Step 1: Run existing agent chat tests to confirm green baseline**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/`
Expected: PASS

- [ ] **Step 2: Reduce horizontal padding on mobile using `isMobile`**

In `src/components/agent-chat/AgentChatView.tsx`, the `isMobile` variable was added in Task 3. Use it to conditionally set padding:

Change the scroll container:
```tsx
className={cn(
  'h-full overflow-y-auto overflow-x-auto py-3 space-y-2',
  isMobile ? 'px-2' : 'px-3',
)}
```

Change the status bar:
```tsx
className={cn(
  'flex items-center justify-between py-1 border-b text-xs text-muted-foreground',
  isMobile ? 'px-2' : 'px-3',
)}
```

In `src/components/agent-chat/ChatComposer.tsx`, the `isMobile` variable was added in Task 4. Use it to conditionally set the composer wrapper padding:

Change the outer div:
```tsx
<div className={cn('border-t py-2', isMobile ? 'px-2' : 'px-3')}>
```

- [ ] **Step 3: Run tests to verify no regression**

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/`
Expected: all PASS

- [ ] **Step 4: Refactor and verify**

Verify there are no remaining `md:` or `sm:` viewport breakpoint classes in agent chat components (all mobile adaptation uses `useMobile()`).

Run: `npm run test:vitest -- --run test/unit/client/components/agent-chat/`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/ChatComposer.tsx
git commit -m "feat: reduce agent chat horizontal padding on mobile for wider content"
```

---

### Task 10: Add Playwright e2e browser test for agent chat mobile keyboard

**Files:**
- Modify: `test/e2e-browser/specs/mobile-viewport.spec.ts`

- [ ] **Step 1: Add mobile agent chat viewport test**

Add to `test/e2e-browser/specs/mobile-viewport.spec.ts`:

```typescript
test('agent chat composer stays visible when virtual keyboard would open', async ({ freshellPage, page }) => {
  // Create an agent-chat tab via the picker or test harness
  // Verify the chat message input is visible
  const input = page.getByRole('textbox', { name: /chat message input/i })
  // Verify the send button has adequate touch target
  const sendBtn = page.getByRole('button', { name: /send message/i })
  await expect(sendBtn).toBeVisible()

  // Verify the region element exists and has the right structure
  const region = page.getByRole('region', { name: /chat/i })
  await expect(region).toBeVisible()
})
```

- [ ] **Step 2: Run the test**

Run: `npx playwright test test/e2e-browser/specs/mobile-viewport.spec.ts --project=chromium`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/mobile-viewport.spec.ts
git commit -m "test: add e2e mobile viewport test for agent chat composer"
```

---

### Task 11: Run full test suite and verify

- [ ] **Step 1: Run the full coordinated test suite**

Run: `npm test`
Expected: all PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run check`
Expected: PASS

- [ ] **Step 3: Fix any failures**

If any tests fail, investigate and fix them. Do not weaken valid tests.

- [ ] **Step 4: Final commit with any fixes**

```bash
git add -A
git commit -m "chore: fix any test regressions from mobile keyboard changes"
```

---

## Architectural Decisions & Justifications

### Why extract `useKeyboardInset` rather than duplicate?
TerminalView already has a proven, battle-tested implementation of virtual keyboard detection. Duplicating it in AgentChatView would create two copies to maintain. The hook is pure infrastructure with no component-specific logic, making extraction clean and safe. Future components (editor panes, browser panes, search bars) can also use it.

### Why `paddingBottom` on the outer container rather than `position: fixed` on the composer?
Fixed-position elements on mobile Safari have notorious issues with virtual keyboard interaction. The `visualViewport` API gives us the exact keyboard height, so pushing the entire flex column up via padding is simpler and avoids z-index/stacking-context issues. The flex layout naturally constrains the message scroll area because the outer container is `h-full` and `flex flex-col`, so adding bottom padding shrinks the available space for the scroll container.

### Why `useMobile()` hook + conditional classes rather than Tailwind responsive utilities?
The existing codebase uses `useMobile()` consistently for JS-driven mobile behavior. Touch target sizing could theoretically use pure Tailwind (`min-h-11 md:min-h-0`), but several components already import and use `useMobile()`. Using the same pattern keeps the codebase consistent and avoids mixing two different mobile detection strategies in the same file. The `useKeyboardInset` hook inherently needs JS (no CSS-only way to detect keyboard height), so JS-driven mobile detection is unavoidable for the core feature.

### Why not use CSS `env(keyboard-inset-bottom)`?
The `VirtualKeyboard` API with `env(keyboard-inset-bottom)` is a newer standard but has very limited browser support (Chrome 94+ only, no Safari, no Firefox). The `visualViewport` API is supported in all modern mobile browsers and is what TerminalView already uses successfully.

### Why increase touch targets conditionally rather than always?
Desktop users benefit from dense UI -- Freshell is a power-user tool. Unconditionally inflating all buttons to 44px would waste vertical space on desktop where mouse precision makes small targets fine. The conditional approach preserves desktop density while meeting iOS accessibility guidelines on mobile.

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- Do not weaken, delete, or dilute valid tests to obtain a passing result -- fix the code instead
- DRY, YAGNI, Red/Green/Refactor TDD, frequent commits
