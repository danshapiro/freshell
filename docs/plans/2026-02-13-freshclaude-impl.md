# Freshclaude Client Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename Claude Web to freshclaude, add per-pane settings popover with model/permissions/display toggles, fix scroll preservation, fix permission status text, and add a new icon.

**Architecture:** Per-pane settings stored in `ClaudeChatPaneContent` (Redux + localStorage persistence). CSS-based hiding for scroll preservation. New `FreshclaudeSettings` popover component with click-outside-to-close and Escape key handling. Uses existing `Switch` component from `@/components/ui/switch`. New inline SVG icon component in `provider-icons.tsx`.

**Tech Stack:** React 18, Redux Toolkit, Tailwind CSS, existing shadcn-style UI components (Switch), Vitest, Testing Library

**Important notes:**
- Line numbers are approximate — earlier tasks modify `ClaudeChatView.tsx` so later tasks must locate code by semantic context, not line numbers.
- `DEFAULT_MODEL` and `DEFAULT_PERMISSION_MODE` constants are defined once in Task 3 and reused thereafter.
- `paneContentRef.current` (already defined in the component at line 25-26) is used in all callbacks to avoid stale closures.
- `ClaudeChatPaneInput` (derived via `Omit` from `ClaudeChatPaneContent`) automatically inherits all new optional fields.

---

### Task 1: Rename "Claude Web" → "freshclaude" (text + comments + tests)

**Files:**
- Modify: `src/lib/derivePaneTitle.ts:21`
- Modify: `src/components/panes/PanePicker.tsx:77,79,82`
- Modify: `src/components/claude-chat/ClaudeChatView.tsx:140,161`
- Modify: `src/components/panes/PaneContainer.tsx:518`
- Modify: `src/store/paneTypes.ts:62` (JSDoc comment)
- Modify: `src/App.tsx:333` (comment)
- Test: `test/unit/client/lib/derivePaneTitle.test.ts`
- Test: `test/unit/client/components/panes/PanePicker.test.tsx:151,160`

**Step 1: Write failing test for claude-chat pane title**

In `test/unit/client/lib/derivePaneTitle.test.ts`, add:

```typescript
it('returns "freshclaude" for claude-chat content', () => {
  const content: PaneContent = {
    kind: 'claude-chat',
    createRequestId: 'test',
    status: 'idle',
  }
  expect(derivePaneTitle(content)).toBe('freshclaude')
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/lib/derivePaneTitle.test.ts`
Expected: FAIL — currently returns `'Claude Web'`

**Step 3: Update all user-facing text and comments**

- `src/lib/derivePaneTitle.ts:21` — change `'Claude Web'` to `'freshclaude'`
- `src/components/panes/PanePicker.tsx:79` — change `label: 'Claude Web'` to `label: 'freshclaude'`
- `src/components/panes/PanePicker.tsx:77` — update comment `// Claude Web option:` → `// freshclaude option:`
- `src/components/panes/PanePicker.tsx:82` — update comment `// Order: CLIs, Claude Web,` → `// Order: CLIs, freshclaude,`
- `src/components/claude-chat/ClaudeChatView.tsx:140` — change `aria-label="Claude Web Chat"` to `aria-label="freshclaude Chat"`
- `src/components/claude-chat/ClaudeChatView.tsx:161` — change `Claude Web Chat` to `freshclaude`
- `src/components/panes/PaneContainer.tsx:518` — change `'Claude Web'` to `'freshclaude'`
- `src/store/paneTypes.ts:62` — change JSDoc `Claude Web chat pane` → `freshclaude chat pane`
- `src/App.tsx:333` — change comment `Claude Web pane` → `freshclaude pane`

**Step 4: Update PanePicker test**

In `test/unit/client/components/panes/PanePicker.test.tsx`:
- Line 151: change test description `'renders options in correct order: CLIs, Claude Web, Editor, Browser, Shell'` → `'renders options in correct order: CLIs, freshclaude, Editor, Browser, Shell'`
- Line 160: change `expect(labels[2]).toBe('Claude Web')` → `expect(labels[2]).toBe('freshclaude')`

**Step 5: Run all affected tests**

Run: `npm test -- --run test/unit/client/lib/derivePaneTitle.test.ts test/unit/client/components/panes/PanePicker.test.tsx`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/derivePaneTitle.ts src/components/panes/PanePicker.tsx src/components/claude-chat/ClaudeChatView.tsx src/components/panes/PaneContainer.tsx src/store/paneTypes.ts src/App.tsx test/unit/client/lib/derivePaneTitle.test.ts test/unit/client/components/panes/PanePicker.test.tsx
git commit -m "feat: rename Claude Web to freshclaude in all user-facing text, comments, and tests"
```

---

### Task 2: Add per-pane settings fields to ClaudeChatPaneContent

**Files:**
- Modify: `src/store/paneTypes.ts:64-76`

**Step 1: Add new optional fields to ClaudeChatPaneContent**

In `src/store/paneTypes.ts`, update the `ClaudeChatPaneContent` type. Add these fields after `initialCwd?`:

```typescript
  /** Model to use (default: claude-opus-4-6) */
  model?: string
  /** Permission mode (default: dangerouslySkipPermissions) */
  permissionMode?: string
  /** Show thinking blocks in message feed (default: true) */
  showThinking?: boolean
  /** Show tool-use blocks in message feed (default: true) */
  showTools?: boolean
  /** Show timestamps on messages (default: false) */
  showTimecodes?: boolean
  /** Whether the user has dismissed the first-launch settings popover */
  settingsDismissed?: boolean
```

Note: `ClaudeChatPaneInput` is derived via `Omit<ClaudeChatPaneContent, ...>` so it automatically inherits these new optional fields. No changes needed there.

**Step 2: Run full test suite to verify no breakage**

Run: `npm test -- --run`
Expected: PASS (new fields are all optional, no breaking changes)

**Step 3: Commit**

```bash
git add src/store/paneTypes.ts
git commit -m "feat: add settings fields to ClaudeChatPaneContent (model, permissions, display toggles)"
```

---

### Task 3: Pass model and permissionMode defaults in sdk.create

**Files:**
- Modify: `src/components/claude-chat/ClaudeChatView.tsx`

**Step 1: Add `cn` import and default constants**

Add `cn` import (needed later in Task 5 but added now to avoid forgetting):

```typescript
import { cn } from '@/lib/utils'
```

Add constants at the top of the file (outside the component):

```typescript
const DEFAULT_MODEL = 'claude-opus-4-6'
const DEFAULT_PERMISSION_MODE = 'dangerouslySkipPermissions'
```

These constants are defined once here and reused in Task 8 (no need to re-add).

**Step 2: Update the sdk.create ws.send call**

In the `sdk.create` effect, find the `ws.send({ type: 'sdk.create', ... })` call and update to include model and permissionMode from pane content with defaults:

```typescript
ws.send({
  type: 'sdk.create',
  requestId: paneContent.createRequestId,
  model: paneContent.model ?? DEFAULT_MODEL,
  permissionMode: paneContent.permissionMode ?? DEFAULT_PERMISSION_MODE,
  ...(paneContent.initialCwd ? { cwd: paneContent.initialCwd } : {}),
  ...(paneContent.resumeSessionId ? { resumeSessionId: paneContent.resumeSessionId } : {}),
})
```

**Step 3: Run tests to verify no breakage**

Run: `npm test -- --run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/claude-chat/ClaudeChatView.tsx
git commit -m "feat: default freshclaude to opus 4.6 and dangerouslySkipPermissions"
```

---

### Task 4: Create freshclaude icon

**Files:**
- Create: `assets/icons/freshclaude.svg`
- Modify: `src/components/icons/provider-icons.tsx`
- Modify: `src/components/icons/PaneIcon.tsx`
- Modify: `src/components/panes/PanePicker.tsx:8,79`
- Test: `test/unit/client/components/icons/PaneIcon.test.tsx`

**Step 1: Write failing test for claude-chat icon**

In `test/unit/client/components/icons/PaneIcon.test.tsx`:

First, **replace** the existing mock (the whole `vi.mock('@/components/icons/provider-icons', ...)` block) with one that includes `FreshclaudeIcon`:

```typescript
vi.mock('@/components/icons/provider-icons', () => ({
  ProviderIcon: ({ provider, ...props }: any) => (
    <svg data-testid={`provider-icon-${provider}`} {...props} />
  ),
  FreshclaudeIcon: (props: any) => (
    <svg data-testid="freshclaude-icon" {...props} />
  ),
}))
```

Then add the test:

```typescript
it('renders freshclaude icon for claude-chat panes', () => {
  render(
    <PaneIcon
      content={{
        kind: 'claude-chat',
        createRequestId: 'req-1',
        status: 'idle',
      }}
    />
  )
  expect(screen.getByTestId('freshclaude-icon')).toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/components/icons/PaneIcon.test.tsx`
Expected: FAIL — no `claude-chat` handler in PaneIcon, falls through to `<LayoutGrid>`

**Step 3: Create the freshclaude SVG file**

Create `assets/icons/freshclaude.svg` — a Claude sparkle inside a speech bubble:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 2C6.48 2 2 5.58 2 10c0 2.48 1.3 4.7 3.33 6.22V20l2.78-1.54C9.33 18.8 10.63 19 12 19c5.52 0 10-3.58 10-8S17.52 2 12 2Z"/>
  <path d="M12 6.5 13.09 9.26 16 9.64 13.95 11.54 14.47 14.5 12 13.09 9.53 14.5 10.05 11.54 8 9.64 10.91 9.26Z" fill="var(--background, #fff)"/>
</svg>
```

**Step 4: Add FreshclaudeIcon component to provider-icons.tsx**

In `src/components/icons/provider-icons.tsx`, add before `DefaultProviderIcon`. Use the same SVG fallback color as the .svg file (`#fff`):

```typescript
export function FreshclaudeIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M12 2C6.48 2 2 5.58 2 10c0 2.48 1.3 4.7 3.33 6.22V20l2.78-1.54C9.33 18.8 10.63 19 12 19c5.52 0 10-3.58 10-8S17.52 2 12 2Z"/>
      <path d="M12 6.5 13.09 9.26 16 9.64 13.95 11.54 14.47 14.5 12 13.09 9.53 14.5 10.05 11.54 8 9.64 10.91 9.26Z" fill="var(--background, #fff)"/>
    </svg>
  )
}
```

**Step 5: Add claude-chat case to PaneIcon.tsx**

In `src/components/icons/PaneIcon.tsx`, update the import to include `FreshclaudeIcon`:

```typescript
import { ProviderIcon, FreshclaudeIcon } from '@/components/icons/provider-icons'
```

Add a new case before the `// Picker` fallback (after the `editor` block):

```typescript
if (content.kind === 'claude-chat') {
  return <FreshclaudeIcon className={className} />
}
```

**Step 6: Update PanePicker.tsx to use the new icon**

In `src/components/panes/PanePicker.tsx`:
- **Replace** import: `import claudeWebIconUrl from '../../../assets/icons/claude-web.svg'` → `import freshclaudeIconUrl from '../../../assets/icons/freshclaude.svg'`
- Update the option on line 79: `iconUrl: claudeWebIconUrl` → `iconUrl: freshclaudeIconUrl`

Note: The old `assets/icons/claude-web.svg` file can be kept for now (no references remain after this change; it can be cleaned up in a future housekeeping pass).

**Step 7: Run tests to verify they pass**

Run: `npm test -- --run test/unit/client/components/icons/PaneIcon.test.tsx`
Expected: PASS

**Step 8: Commit**

```bash
git add assets/icons/freshclaude.svg src/components/icons/provider-icons.tsx src/components/icons/PaneIcon.tsx src/components/panes/PanePicker.tsx test/unit/client/components/icons/PaneIcon.test.tsx
git commit -m "feat: add freshclaude icon for claude-chat panes in tabs and pane headers"
```

---

### Task 5: Fix scroll preservation (CSS hiding + smart auto-scroll)

**Files:**
- Modify: `src/components/claude-chat/ClaudeChatView.tsx`
- Test: `test/unit/client/components/claude-chat/ClaudeChatView.scroll.test.tsx`

**Step 1: Write failing test for CSS-based hiding**

Create `test/unit/client/components/claude-chat/ClaudeChatView.scroll.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ClaudeChatView from '@/components/claude-chat/ClaudeChatView'
import claudeChatReducer from '@/store/claudeChatSlice'
import panesReducer from '@/store/panesSlice'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'

// Mock ws-client
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      claudeChat: claudeChatReducer,
      panes: panesReducer,
    },
  })
}

const basePaneContent: ClaudeChatPaneContent = {
  kind: 'claude-chat',
  createRequestId: 'test-req',
  status: 'idle',
  sessionId: 'test-session',
}

describe('ClaudeChatView visibility', () => {
  afterEach(cleanup)

  it('renders with tab-visible class when not hidden', () => {
    const store = makeStore()
    const { container } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={basePaneContent} />
      </Provider>
    )
    const region = container.querySelector('[role="region"]')
    expect(region).toBeInTheDocument()
    expect(region!.className).toContain('tab-visible')
  })

  it('renders with tab-hidden class when hidden (does NOT unmount)', () => {
    const store = makeStore()
    const { container } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={basePaneContent} hidden />
      </Provider>
    )
    const region = container.querySelector('[role="region"]')
    expect(region).toBeInTheDocument()
    expect(region!.className).toContain('tab-hidden')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/components/claude-chat/ClaudeChatView.scroll.test.tsx`
Expected: FAIL — component returns null when hidden, so `region` is null

**Step 3: Replace `if (hidden) return null` with CSS-based hiding**

In `ClaudeChatView.tsx`, remove `if (hidden) return null`.

Update the outer div to use CSS-based hiding (note: `cn` was imported in Task 3):

```typescript
return (
  <div className={cn('h-full w-full flex flex-col', hidden ? 'tab-hidden' : 'tab-visible')} role="region" aria-label="freshclaude Chat">
```

**Step 4: Replace naive auto-scroll with smart auto-scroll**

Near the other refs (after `messagesEndRef` around line 22), add:

```typescript
const scrollContainerRef = useRef<HTMLDivElement>(null)
const isAtBottomRef = useRef(true)
```

After the existing `useCallback` hooks, add the scroll handler:

```typescript
const handleScroll = useCallback(() => {
  const el = scrollContainerRef.current
  if (!el) return
  const threshold = 50
  isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}, [])
```

Replace the existing auto-scroll `useEffect`:

```typescript
// Smart auto-scroll: only scroll if user is already at/near the bottom
useEffect(() => {
  if (isAtBottomRef.current) {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }
}, [session?.messages.length, session?.streamingActive])
```

Add refs to the message area div:

```typescript
<div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-3">
```

**Step 5: Run tests to verify they pass**

Run: `npm test -- --run test/unit/client/components/claude-chat/ClaudeChatView.scroll.test.tsx`
Expected: PASS

**Step 6: Commit**

```bash
git add src/components/claude-chat/ClaudeChatView.tsx test/unit/client/components/claude-chat/ClaudeChatView.scroll.test.tsx
git commit -m "fix: preserve scroll position in freshclaude when navigating away and back

Use CSS tab-hidden/tab-visible classes instead of returning null when
hidden. Add smart auto-scroll that only scrolls to bottom when user is
already near the bottom, preserving their scroll position."
```

---

### Task 6: Fix "Waiting for answer..." status when permissions are pending

**Files:**
- Modify: `src/components/claude-chat/ClaudeChatView.tsx`
- Test: `test/unit/client/components/claude-chat/ClaudeChatView.status.test.tsx`

**Step 1: Write failing test**

Create `test/unit/client/components/claude-chat/ClaudeChatView.status.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ClaudeChatView from '@/components/claude-chat/ClaudeChatView'
import claudeChatReducer, { sessionCreated, addPermissionRequest } from '@/store/claudeChatSlice'
import panesReducer from '@/store/panesSlice'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      claudeChat: claudeChatReducer,
      panes: panesReducer,
    },
  })
}

describe('ClaudeChatView status text', () => {
  afterEach(cleanup)

  it('shows "Waiting for answer..." when permissions are pending', () => {
    const store = makeStore()
    // Create a session with a pending permission
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addPermissionRequest({
      sessionId: 'sess-1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'ls' } },
    }))

    const paneContent: ClaudeChatPaneContent = {
      kind: 'claude-chat',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'running',
    }

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={paneContent} />
      </Provider>
    )

    expect(screen.getByText('Waiting for answer...')).toBeInTheDocument()
  })

  it('shows "Running..." when no permissions are pending', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    const paneContent: ClaudeChatPaneContent = {
      kind: 'claude-chat',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'running',
    }

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={paneContent} />
      </Provider>
    )

    expect(screen.getByText('Running...')).toBeInTheDocument()
  })
})
```

Note: The exact Redux action names (`sessionCreated`, `addPermissionRequest`) may differ — check `claudeChatSlice.ts` for the actual exports and adjust accordingly.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/components/claude-chat/ClaudeChatView.status.test.tsx`
Expected: FAIL — shows "Running..." even with pending permissions

**Step 3: Update status bar text**

Find the status bar `<span>` in ClaudeChatView.tsx and update to check for pending permissions. The `pendingPermissions` variable is already computed before the JSX return — no need to move it.

Replace the status text span:

```typescript
<span>
  {pendingPermissions.length > 0 && 'Waiting for answer...'}
  {pendingPermissions.length === 0 && paneContent.status === 'creating' && 'Creating session...'}
  {pendingPermissions.length === 0 && paneContent.status === 'starting' && 'Starting Claude Code...'}
  {pendingPermissions.length === 0 && paneContent.status === 'connected' && 'Connected'}
  {pendingPermissions.length === 0 && paneContent.status === 'running' && 'Running...'}
  {pendingPermissions.length === 0 && paneContent.status === 'idle' && 'Ready'}
  {pendingPermissions.length === 0 && paneContent.status === 'compacting' && 'Compacting context...'}
  {pendingPermissions.length === 0 && paneContent.status === 'exited' && 'Session ended'}
</span>
```

**Step 4: Update the composer placeholder**

Find the `ChatComposer` placeholder prop and update:

```typescript
placeholder={
  pendingPermissions.length > 0
    ? 'Waiting for answer...'
    : isInteractive
      ? 'Message Claude...'
      : 'Waiting for connection...'
}
```

**Step 5: Run tests to verify they pass**

Run: `npm test -- --run test/unit/client/components/claude-chat/ClaudeChatView.status.test.tsx`
Expected: PASS

**Step 6: Commit**

```bash
git add src/components/claude-chat/ClaudeChatView.tsx test/unit/client/components/claude-chat/ClaudeChatView.status.test.tsx
git commit -m "fix: show 'Waiting for answer...' when permission prompt is pending"
```

---

### Task 7: Create FreshclaudeSettings popover component

**Files:**
- Create: `src/components/claude-chat/FreshclaudeSettings.tsx`
- Test: `test/unit/client/components/claude-chat/FreshclaudeSettings.test.tsx`

This component uses a proper popover pattern with click-outside-to-close and Escape key handling, plus the existing `Switch` component from `@/components/ui/switch`.

**Step 1: Write the failing test**

Create `test/unit/client/components/claude-chat/FreshclaudeSettings.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import FreshclaudeSettings from '@/components/claude-chat/FreshclaudeSettings'

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Settings: (props: any) => <svg data-testid="settings-icon" {...props} />,
}))

describe('FreshclaudeSettings', () => {
  afterEach(cleanup)

  const defaults = {
    model: 'claude-opus-4-6',
    permissionMode: 'dangerouslySkipPermissions',
    showThinking: true,
    showTools: true,
    showTimecodes: false,
  }

  it('renders the settings gear button', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument()
  })

  it('opens popover when gear button is clicked', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        onChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.getByText('Permissions')).toBeInTheDocument()
  })

  it('closes popover on Escape key', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('Model')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByText('Model')).not.toBeInTheDocument()
  })

  it('closes popover on click outside', () => {
    render(
      <div>
        <FreshclaudeSettings
          {...defaults}
          sessionStarted={false}
          defaultOpen={true}
          onChange={vi.fn()}
        />
        <button data-testid="outside">Outside</button>
      </div>
    )
    expect(screen.getByText('Model')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByText('Model')).not.toBeInTheDocument()
  })

  it('disables model and permission dropdowns when session has started', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={true}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )
    const modelSelect = screen.getByLabelText('Model')
    expect(modelSelect).toBeDisabled()
    const permSelect = screen.getByLabelText('Permissions')
    expect(permSelect).toBeDisabled()
  })

  it('calls onChange when a display toggle is changed', () => {
    const onChange = vi.fn()
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole('switch', { name: /show timecodes/i }))
    expect(onChange).toHaveBeenCalledWith({ showTimecodes: true })
  })

  it('calls onChange when model is changed', () => {
    const onChange = vi.fn()
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-sonnet-4-5-20250929' } })
    expect(onChange).toHaveBeenCalledWith({ model: 'claude-sonnet-4-5-20250929' })
  })

  it('opens automatically when defaultOpen is true', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('Model')).toBeInTheDocument()
  })

  it('calls onDismiss when closed', () => {
    const onDismiss = vi.fn()
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/components/claude-chat/FreshclaudeSettings.test.tsx`
Expected: FAIL — module not found

**Step 3: Implement FreshclaudeSettings component**

Create `src/components/claude-chat/FreshclaudeSettings.tsx`:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'

type SettingsFields = Pick<ClaudeChatPaneContent, 'model' | 'permissionMode' | 'showThinking' | 'showTools' | 'showTimecodes'>

interface FreshclaudeSettingsProps {
  model: string
  permissionMode: string
  showThinking: boolean
  showTools: boolean
  showTimecodes: boolean
  sessionStarted: boolean
  defaultOpen?: boolean
  onChange: (changes: Partial<SettingsFields>) => void
  onDismiss?: () => void
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

const PERMISSION_OPTIONS = [
  { value: 'dangerouslySkipPermissions', label: 'Skip permissions' },
  { value: 'default', label: 'Default (ask)' },
]

export default function FreshclaudeSettings({
  model,
  permissionMode,
  showThinking,
  showTools,
  showTimecodes,
  sessionStarted,
  defaultOpen = false,
  onChange,
  onDismiss,
}: FreshclaudeSettingsProps) {
  const [open, setOpen] = useState(defaultOpen)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleClose = useCallback(() => {
    setOpen(false)
    onDismiss?.()
  }, [onDismiss])

  const handleToggle = useCallback(() => {
    if (open) {
      handleClose()
    } else {
      setOpen(true)
    }
  }, [open, handleClose])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) {
        handleClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open, handleClose])

  // Close on Escape key (handled via onKeyDown on the dialog)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      handleClose()
    }
  }, [handleClose])

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className={cn(
          'p-1 rounded hover:bg-muted transition-colors',
          open && 'bg-muted'
        )}
        aria-label="Settings"
        aria-expanded={open}
      >
        <Settings className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border bg-popover p-3 shadow-lg"
          role="dialog"
          aria-label="freshclaude settings"
          onKeyDown={handleKeyDown}
        >
          <div className="space-y-3">
            {/* Model */}
            <div className="space-y-1">
              <label htmlFor="fc-model" className="text-xs font-medium">Model</label>
              <select
                id="fc-model"
                aria-label="Model"
                value={model}
                disabled={sessionStarted}
                onChange={(e) => onChange({ model: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1 text-xs disabled:opacity-50"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Permission mode */}
            <div className="space-y-1">
              <label htmlFor="fc-permissions" className="text-xs font-medium">Permissions</label>
              <select
                id="fc-permissions"
                aria-label="Permissions"
                value={permissionMode}
                disabled={sessionStarted}
                onChange={(e) => onChange({ permissionMode: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1 text-xs disabled:opacity-50"
              >
                {PERMISSION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <hr className="border-border" />

            {/* Display toggles using existing Switch component */}
            <ToggleRow
              label="Show thinking"
              checked={showThinking}
              onChange={(v) => onChange({ showThinking: v })}
            />
            <ToggleRow
              label="Show tools"
              checked={showTools}
              onChange={(v) => onChange({ showTools: v })}
            />
            <ToggleRow
              label="Show timecodes"
              checked={showTimecodes}
              onChange={(v) => onChange({ showTimecodes: v })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs">{label}</span>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  )
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run test/unit/client/components/claude-chat/FreshclaudeSettings.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/claude-chat/FreshclaudeSettings.tsx test/unit/client/components/claude-chat/FreshclaudeSettings.test.tsx
git commit -m "feat: add FreshclaudeSettings popover with click-outside, Escape, model/permissions/display toggles"
```

---

### Task 8: Wire FreshclaudeSettings into ClaudeChatView

**Files:**
- Modify: `src/components/claude-chat/ClaudeChatView.tsx`

**Step 1: Add import**

```typescript
import FreshclaudeSettings from './FreshclaudeSettings'
```

Note: `DEFAULT_MODEL` and `DEFAULT_PERMISSION_MODE` were already defined in Task 3. Do not re-add them.

**Step 2: Add settings change handlers**

Inside the component, add after the existing `useCallback` hooks (e.g., after `handlePermissionDeny`):

```typescript
const handleSettingsChange = useCallback((changes: Record<string, unknown>) => {
  dispatch(updatePaneContent({
    tabId,
    paneId,
    content: { ...paneContentRef.current, ...changes },
  }))
}, [tabId, paneId, dispatch])

const handleSettingsDismiss = useCallback(() => {
  dispatch(updatePaneContent({
    tabId,
    paneId,
    content: { ...paneContentRef.current, settingsDismissed: true },
  }))
}, [tabId, paneId, dispatch])

const sessionStarted = Boolean(session?.messages.length)
```

Note: These use `paneContentRef.current` (already defined at line 25-26 of the existing component) to avoid stale closures.

**Step 3: Add settings gear to the status bar**

Restructure the status bar div to include a right-side group with the cwd display and settings gear:

```typescript
<div className="flex items-center justify-between px-3 py-1.5 border-b text-xs text-muted-foreground">
  <span>
    {/* ...existing status text (with pending permissions logic from Task 6)... */}
  </span>
  <div className="flex items-center gap-2">
    {paneContent.initialCwd && (
      <span className="truncate">{paneContent.initialCwd}</span>
    )}
    <FreshclaudeSettings
      model={paneContent.model ?? DEFAULT_MODEL}
      permissionMode={paneContent.permissionMode ?? DEFAULT_PERMISSION_MODE}
      showThinking={paneContent.showThinking ?? true}
      showTools={paneContent.showTools ?? true}
      showTimecodes={paneContent.showTimecodes ?? false}
      sessionStarted={sessionStarted}
      defaultOpen={!paneContent.settingsDismissed}
      onChange={handleSettingsChange}
      onDismiss={handleSettingsDismiss}
    />
  </div>
</div>
```

**Step 4: Pass display toggles to MessageBubble**

Update both `MessageBubble` renders to pass the display toggle props:

For the messages list:
```typescript
<MessageBubble
  key={i}
  role={msg.role}
  content={msg.content}
  timestamp={msg.timestamp}
  model={msg.model}
  showThinking={paneContent.showThinking ?? true}
  showTools={paneContent.showTools ?? true}
  showTimecodes={paneContent.showTimecodes ?? false}
/>
```

For the streaming bubble:
```typescript
<MessageBubble
  role="assistant"
  content={[{ type: 'text', text: session.streamingText }]}
  showThinking={paneContent.showThinking ?? true}
  showTools={paneContent.showTools ?? true}
  showTimecodes={paneContent.showTimecodes ?? false}
/>
```

**Step 5: Run tests to verify no breakage**

Run: `npm test -- --run`
Expected: PASS

**Step 6: Commit**

```bash
git add src/components/claude-chat/ClaudeChatView.tsx
git commit -m "feat: wire FreshclaudeSettings into ClaudeChatView status bar with display toggle props"
```

---

### Task 9: Update MessageBubble to respect display toggles

**Files:**
- Modify: `src/components/claude-chat/MessageBubble.tsx`
- Test: `test/unit/client/components/claude-chat/MessageBubble.test.tsx`

**Step 1: Write failing tests**

Create `test/unit/client/components/claude-chat/MessageBubble.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MessageBubble from '@/components/claude-chat/MessageBubble'
import type { ChatContentBlock } from '@/store/claudeChatTypes'

// Mock react-markdown to render text directly
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}))

vi.mock('remark-gfm', () => ({ default: () => {} }))

// Mock ToolBlock
vi.mock('@/components/claude-chat/ToolBlock', () => ({
  default: ({ name }: { name: string }) => <div data-testid={`tool-${name}`}>{name}</div>,
}))

const thinkingBlock: ChatContentBlock = { type: 'thinking', thinking: 'Let me think about this...' }
const toolUseBlock: ChatContentBlock = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }
const toolResultBlock: ChatContentBlock = { type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }
const textBlock: ChatContentBlock = { type: 'text', text: 'Hello world' }

describe('MessageBubble display toggles', () => {
  afterEach(cleanup)

  it('hides thinking blocks when showThinking is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, thinkingBlock]}
        showThinking={false}
      />
    )
    expect(screen.queryByText(/Let me think/)).not.toBeInTheDocument()
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('shows thinking blocks when showThinking is true', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[thinkingBlock]}
        showThinking={true}
      />
    )
    expect(screen.getByText(/Let me think/)).toBeInTheDocument()
  })

  it('hides tool_use blocks when showTools is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, toolUseBlock]}
        showTools={false}
      />
    )
    expect(screen.queryByTestId('tool-Bash')).not.toBeInTheDocument()
  })

  it('hides tool_result blocks when showTools is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, toolResultBlock]}
        showTools={false}
      />
    )
    expect(screen.queryByTestId('tool-Result')).not.toBeInTheDocument()
  })

  it('shows timestamp when showTimecodes is true', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock]}
        timestamp="2026-02-13T10:00:00Z"
        showTimecodes={true}
      />
    )
    expect(screen.getByRole('article').querySelector('time')).toBeInTheDocument()
  })

  it('hides timestamp when showTimecodes is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock]}
        timestamp="2026-02-13T10:00:00Z"
        showTimecodes={false}
      />
    )
    expect(screen.getByRole('article').querySelector('time')).not.toBeInTheDocument()
  })

  it('defaults to showing thinking and tools, hiding timecodes', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, thinkingBlock, toolUseBlock]}
        timestamp="2026-02-13T10:00:00Z"
      />
    )
    expect(screen.getByText(/Let me think/)).toBeInTheDocument()
    expect(screen.getByTestId('tool-Bash')).toBeInTheDocument()
    expect(screen.getByRole('article').querySelector('time')).not.toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/components/claude-chat/MessageBubble.test.tsx`
Expected: FAIL — `showThinking` prop not recognized, thinking blocks still render

**Step 3: Add new props to MessageBubble**

Update the interface and function signature:

```typescript
interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: ChatContentBlock[]
  timestamp?: string
  model?: string
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
}

function MessageBubble({ role, content, timestamp, model, showThinking = true, showTools = true, showTimecodes = false }: MessageBubbleProps) {
```

**Step 4: Add toggle guards to content block rendering**

In the `content.map((block, i) => { ... })` callback, add early returns:

```typescript
if (block.type === 'thinking' && block.thinking) {
  if (!showThinking) return null
  // ... existing thinking render unchanged ...
}

if (block.type === 'tool_use' && block.name) {
  if (!showTools) return null
  // ... existing tool_use render unchanged ...
}

if (block.type === 'tool_result') {
  if (!showTools) return null
  // ... existing tool_result render unchanged ...
}
```

**Step 5: Update timestamp display**

Replace the existing timestamp/model footer:

```typescript
{((showTimecodes && timestamp) || model) && (
  <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
    {showTimecodes && timestamp && <time>{new Date(timestamp).toLocaleTimeString()}</time>}
    {model && <span className="opacity-60">{model}</span>}
  </div>
)}
```

**Step 6: Run tests to verify they pass**

Run: `npm test -- --run test/unit/client/components/claude-chat/MessageBubble.test.tsx`
Expected: PASS

**Step 7: Commit**

```bash
git add src/components/claude-chat/MessageBubble.tsx test/unit/client/components/claude-chat/MessageBubble.test.tsx
git commit -m "feat: MessageBubble respects showThinking, showTools, showTimecodes toggles"
```

---

### Task 10: Full test suite + verify build

**Step 1: Run full test suite and build**

Run: `npm run verify`
Expected: Build succeeds, all tests pass

**Step 2: Fix any issues found**

Address any type errors or test failures. Common things to check:
- TypeScript errors from the new `Partial<SettingsFields>` type in `onChange`
- Any tests that assert on the old "Claude Web" text
- Import resolution issues

**Step 3: Final commit if needed**

```bash
git commit -m "fix: address test/build issues from freshclaude improvements"
```
