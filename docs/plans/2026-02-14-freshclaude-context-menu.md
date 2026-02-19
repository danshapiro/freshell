# Freshclaude Context Menu Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the freshclaude live chat a right-click context menu with Copy/Select All everywhere, plus context-sensitive items when clicking on code blocks, tool inputs, tool outputs, and diffs.

**Architecture:** Add a single new context type `FreshclaudeChat` on the scroll container. Extend `MenuState` and `MenuBuildContext` with a `clickTarget` field (the actual `e.target` element) so the menu builder can use `closest()` to detect which sub-region was clicked. Tag sub-elements with `data-*` attributes (not `data-context`) for detection. The menu always shows Copy + Select All, then conditionally adds specialized items based on the click target's nearest tagged ancestor.

**Tech Stack:** React, TypeScript, Vitest + Testing Library, existing context menu infrastructure (`ContextMenuProvider`, `menu-defs.ts`)

---

### Task 1: Add `clickTarget` to MenuState and MenuBuildContext

**Why:** Currently `contextElement` is the nearest `data-context` ancestor — we lose what was actually clicked. We need the original click target so the menu builder can use `closest()` to detect sub-regions (code block, tool input, tool output, diff).

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:30-35` (MenuState type)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:600-616` (handleContextMenu)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:622-639` (handleKeyDown)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:682-691` (menuItems useMemo)
- Modify: `src/components/context-menu/menu-defs.ts:55-65` (MenuBuildContext type)
- Modify: `src/components/context-menu/menu-defs.ts:123-124` (buildMenuItems destructure)
- Test: `test/unit/client/components/context-menu/menu-defs.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/client/components/context-menu/menu-defs.test.ts`:

```typescript
describe('buildMenuItems — clickTarget passthrough', () => {
  it('receives clickTarget in context', () => {
    // Verify the interface accepts clickTarget without error
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const el = document.createElement('span')
    mockContext.clickTarget = el
    const target: ContextTarget = { kind: 'global' }
    const items = buildMenuItems(target, mockContext)
    expect(items.length).toBeGreaterThan(0)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: TypeScript error — `clickTarget` doesn't exist on `MenuBuildContext`

**Step 3: Implement**

In `src/components/context-menu/ContextMenuProvider.tsx`, add `clickTarget` to `MenuState`:

```typescript
type MenuState = {
  position: { x: number; y: number }
  target: ContextTarget
  contextElement: HTMLElement | null
  clickTarget: HTMLElement | null    // ← ADD
  dataset: Record<string, string | undefined>
}
```

In `handleContextMenu` (~line 611), store `target` as `clickTarget`:

```typescript
openMenu({
  position: { x: e.clientX, y: e.clientY },
  target: targetObj,
  contextElement: contextEl,
  clickTarget: target,    // ← ADD (the original e.target)
  dataset,
})
```

In `handleKeyDown` (~line 634), store `target` as `clickTarget`:

```typescript
openMenu({
  position: { x: rect.left + 8, y: rect.bottom + 4 },
  target: targetObj,
  contextElement: contextEl,
  clickTarget: target,    // ← ADD (document.activeElement)
  dataset,
})
```

In `menuItems` useMemo (~line 684), pass `clickTarget`:

```typescript
return buildMenuItems(menuState.target, {
  ...existingProps,
  clickTarget: menuState.clickTarget,    // ← ADD
})
```

In `src/components/context-menu/menu-defs.ts`, add to `MenuBuildContext`:

```typescript
export type MenuBuildContext = {
  // ... existing fields ...
  clickTarget: HTMLElement | null   // ← ADD
}
```

And destructure it in `buildMenuItems`:

```typescript
export function buildMenuItems(target: ContextTarget, ctx: MenuBuildContext): MenuItem[] {
  const { actions, tabs, paneLayouts, sessions, view, sidebarCollapsed, expandedProjects, contextElement, clickTarget, platform } = ctx
```

Also update `createMockContext` in the test file to include `clickTarget: null`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(context-menu): add clickTarget to MenuState and MenuBuildContext

Store the original right-click target element (e.target) alongside the
contextElement (nearest data-context ancestor). This allows menu builders
to use closest() on the actual clicked element to detect sub-regions
like code blocks, tool inputs, etc.
```

---

### Task 2: Register `FreshclaudeChat` context type

**Why:** The freshclaude chat scroll area needs a `data-context` so the context menu system recognizes it and doesn't fall through to the empty global menu.

**Files:**
- Modify: `src/components/context-menu/context-menu-constants.ts:1-16`
- Modify: `src/components/context-menu/context-menu-types.ts:4-18`
- Modify: `src/components/context-menu/context-menu-utils.ts:31-84`
- Test: `test/unit/client/components/context-menu/menu-defs.test.ts`

**Step 1: Write the failing test**

```typescript
describe('buildMenuItems — freshclaude-chat context', () => {
  it('returns Copy and Select all for freshclaude-chat target', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 'sess-1' }
    const items = buildMenuItems(target, mockContext)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: TypeScript error — `freshclaude-chat` doesn't exist on `ContextTarget`

**Step 3: Implement**

In `context-menu-constants.ts`, add:

```typescript
FreshclaudeChat: 'freshclaude-chat',
```

In `context-menu-types.ts`, add to `ContextTarget` union:

```typescript
| { kind: 'freshclaude-chat'; sessionId: string }
```

In `context-menu-utils.ts`, add case in `parseContextTarget`:

```typescript
case ContextIds.FreshclaudeChat:
  return data.sessionId ? { kind: 'freshclaude-chat', sessionId: data.sessionId } : null
```

In `menu-defs.ts`, add the menu builder (before the final `return []`). For now, just the base items — we'll add context-sensitive items in the next tasks:

```typescript
if (target.kind === 'freshclaude-chat') {
  const selection = window.getSelection()
  const hasSelection = !!(selection && selection.toString().trim())
  return [
    {
      type: 'item',
      id: 'fc-copy',
      label: 'Copy',
      onSelect: () => {
        if (hasSelection) document.execCommand('copy')
      },
      disabled: !hasSelection,
    },
    {
      type: 'item',
      id: 'fc-select-all',
      label: 'Select all',
      onSelect: () => {
        const range = document.createRange()
        if (contextElement) {
          range.selectNodeContents(contextElement)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      },
    },
  ]
}
```

Also add `copyFreshclaudeContent` and related actions to `MenuActions` type — we'll need these later:

```typescript
copyFreshclaudeCodeBlock: (clickTarget: HTMLElement | null) => void
copyFreshclaudeToolInput: (clickTarget: HTMLElement | null) => void
copyFreshclaudeToolOutput: (clickTarget: HTMLElement | null) => void
copyFreshclaudeDiffNew: (clickTarget: HTMLElement | null) => void
copyFreshclaudeDiffOld: (clickTarget: HTMLElement | null) => void
copyFreshclaudeFilePath: (clickTarget: HTMLElement | null) => void
```

Add these to `createMockActions()` in the test too (all as `vi.fn()`), and update `ContextMenuProvider.tsx` to wire them through as `vi.fn()`-equivalent stubs (we'll implement the real ones in Task 4).

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(context-menu): register FreshclaudeChat context type with Copy/Select All

Add 'freshclaude-chat' to context ID registry with base menu items:
Copy (browser selection) and Select All other. Future tasks will add
context-sensitive items for code blocks, tool I/O, and diffs.
```

---

### Task 3: Wire `data-context` onto ClaudeChatView scroll container

**Why:** The scroll area in ClaudeChatView needs `data-context="freshclaude-chat"` so right-clicks trigger the new context menu instead of the empty global fallback.

**Files:**
- Modify: `src/components/claude-chat/ClaudeChatView.tsx:280`
- Test: `test/e2e/claude-chat-polish-flow.test.tsx` (add test)

**Step 1: Write the failing test**

Add to `test/e2e/claude-chat-polish-flow.test.tsx`:

```typescript
describe('freshclaude polish e2e: context menu data attribute', () => {
  afterEach(cleanup)

  it('scroll container has data-context="freshclaude-chat" with session ID', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Hello' }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { container } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const scrollArea = container.querySelector('[data-context="freshclaude-chat"]')
    expect(scrollArea).not.toBeNull()
    expect(scrollArea?.getAttribute('data-session-id')).toBe('sess-1')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/e2e/claude-chat-polish-flow.test.tsx`
Expected: FAIL — no element with `data-context="freshclaude-chat"`

**Step 3: Implement**

In `src/components/claude-chat/ClaudeChatView.tsx:280`, add data attributes to the scroll container:

```tsx
<div
  ref={scrollContainerRef}
  onScroll={handleScroll}
  className="flex-1 overflow-y-auto p-4 space-y-3"
  data-context="freshclaude-chat"
  data-session-id={paneContent.sessionId}
>
```

Import `ContextIds` is NOT needed — we use the string literal because `data-context` is a plain HTML attribute read by `findContextElement`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/e2e/claude-chat-polish-flow.test.tsx`
Expected: PASS

**Step 5: Commit**

```
feat(freshclaude): wire context menu onto chat scroll container

Add data-context="freshclaude-chat" and data-session-id to the scroll
area so right-clicks trigger the freshclaude context menu instead of
falling through to the empty global menu.
```

---

### Task 4: Add data-* tags to ToolBlock sub-elements and DiffView

**Why:** The menu builder needs to distinguish what was clicked. We tag sub-elements with `data-tool-input`, `data-tool-output`, `data-diff`, and `data-file-path` attributes so `clickTarget.closest()` can find them.

**Files:**
- Modify: `src/components/claude-chat/ToolBlock.tsx:139-153` (tag input/output `<pre>` elements)
- Modify: `src/components/claude-chat/DiffView.tsx:44-73` (tag diff container)
- Test: `test/unit/client/components/claude-chat/ToolBlock.test.tsx`
- Test: `test/unit/client/components/claude-chat/DiffView.test.tsx`

**Step 1: Write the failing tests**

Add to `test/unit/client/components/claude-chat/ToolBlock.test.tsx`:

```typescript
describe('ToolBlock data attributes for context menu', () => {
  it('tags tool input with data-tool-input and data-tool-name', () => {
    render(<ToolBlock name="Bash" input={{ command: 'ls' }} status="complete" output="files" initialExpanded />)
    const inputEl = document.querySelector('[data-tool-input]')
    expect(inputEl).not.toBeNull()
    expect(inputEl?.getAttribute('data-tool-name')).toBe('Bash')
  })

  it('tags tool output with data-tool-output', () => {
    render(<ToolBlock name="Bash" input={{ command: 'ls' }} status="complete" output="file1\nfile2" initialExpanded />)
    const outputEl = document.querySelector('[data-tool-output]')
    expect(outputEl).not.toBeNull()
  })
})
```

Add to `test/unit/client/components/claude-chat/DiffView.test.tsx`:

```typescript
it('tags diff container with data-diff and data-file-path', () => {
  const oldStr = ['line1', 'line2'].join('\n')
  const newStr = ['line1', 'changed'].join('\n')
  render(<DiffView oldStr={oldStr} newStr={newStr} filePath="/tmp/test.ts" />)
  const diffEl = document.querySelector('[data-diff]')
  expect(diffEl).not.toBeNull()
  expect(diffEl?.getAttribute('data-file-path')).toBe('/tmp/test.ts')
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/client/components/claude-chat/ToolBlock.test.tsx test/unit/client/components/claude-chat/DiffView.test.tsx`
Expected: FAIL — no `data-tool-input`, `data-tool-output`, `data-diff` attributes

**Step 3: Implement**

In `src/components/claude-chat/ToolBlock.tsx`, tag the input `<pre>` (~line 140):

```tsx
<pre
  className="whitespace-pre-wrap font-mono opacity-80 max-h-48 overflow-y-auto"
  data-tool-input=""
  data-tool-name={name}
>
```

Tag the output `<pre>` (~line 147):

```tsx
<pre
  className={cn(
    'whitespace-pre-wrap font-mono max-h-48 overflow-y-auto mt-1',
    isError ? 'text-red-500' : 'opacity-80'
  )}
  data-tool-output=""
>
```

In `src/components/claude-chat/DiffView.tsx`, tag the outer diff container (~line 45):

```tsx
<div
  role="figure"
  aria-label="diff view"
  className="text-xs font-mono overflow-x-auto"
  data-diff=""
  data-file-path={filePath}
>
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/client/components/claude-chat/ToolBlock.test.tsx test/unit/client/components/claude-chat/DiffView.test.tsx`
Expected: PASS

**Step 5: Commit**

```
feat(freshclaude): add data-* tags to tool and diff elements

Tag tool input/output <pre> elements with data-tool-input/data-tool-output
and diff containers with data-diff/data-file-path. These tags let the
context menu builder use closest() to detect what was right-clicked.
```

---

### Task 5: Implement context-sensitive menu items in buildMenuItems

**Why:** This is the core feature — detecting what was right-clicked and adding specialized Copy options alongside the base Copy/Select All.

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts` (expand `freshclaude-chat` case)
- Test: `test/unit/client/components/context-menu/menu-defs.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('buildMenuItems — freshclaude-chat context-sensitive items', () => {
  function makeContextWithClickTarget(clickTarget: HTMLElement, contextElement?: HTMLElement) {
    const mockActions = createMockActions()
    return {
      ctx: { ...createMockContext(mockActions), clickTarget, contextElement: contextElement ?? null },
      actions: mockActions,
    }
  }

  it('adds "Copy code block" when clicking inside a <pre><code> in .prose', () => {
    const prose = document.createElement('div')
    prose.className = 'prose'
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = 'const x = 1'
    pre.appendChild(code)
    prose.appendChild(pre)

    const { ctx, actions } = makeContextWithClickTarget(code)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-code-block')
  })

  it('adds "Copy command" when clicking inside a [data-tool-input] for Bash', () => {
    const pre = document.createElement('pre')
    pre.setAttribute('data-tool-input', '')
    pre.setAttribute('data-tool-name', 'Bash')
    pre.textContent = 'echo hello'

    const { ctx, actions } = makeContextWithClickTarget(pre)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-command')
  })

  it('adds "Copy input" (not "Copy command") for non-Bash tools', () => {
    const pre = document.createElement('pre')
    pre.setAttribute('data-tool-input', '')
    pre.setAttribute('data-tool-name', 'Grep')
    pre.textContent = '{"pattern":"foo"}'

    const { ctx } = makeContextWithClickTarget(pre)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-input')
    expect(ids).not.toContain('fc-copy-command')
  })

  it('adds "Copy output" when clicking inside a [data-tool-output]', () => {
    const pre = document.createElement('pre')
    pre.setAttribute('data-tool-output', '')
    pre.textContent = 'file1.txt\nfile2.txt'

    const { ctx } = makeContextWithClickTarget(pre)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-output')
  })

  it('adds diff-specific items when clicking inside a [data-diff]', () => {
    const diff = document.createElement('div')
    diff.setAttribute('data-diff', '')
    diff.setAttribute('data-file-path', '/tmp/test.ts')
    const span = document.createElement('span')
    diff.appendChild(span)

    const { ctx } = makeContextWithClickTarget(span)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-new-version')
    expect(ids).toContain('fc-copy-old-version')
    expect(ids).toContain('fc-copy-file-path')
  })

  it('always includes Copy and Select all', () => {
    const div = document.createElement('div')
    const { ctx } = makeContextWithClickTarget(div)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
  })

  it('includes "Copy session ID" after a separator', () => {
    const div = document.createElement('div')
    const { ctx } = makeContextWithClickTarget(div)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-session')
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: FAIL — the freshclaude-chat menu doesn't yet check `clickTarget`

**Step 3: Implement**

Replace the `freshclaude-chat` block in `menu-defs.ts` with the full context-sensitive version:

```typescript
if (target.kind === 'freshclaude-chat') {
  const selection = window.getSelection()
  const hasSelection = !!(selection && selection.toString().trim())

  // Detect sub-region from click target using closest()
  const codeBlock = clickTarget?.closest?.('.prose pre code') as HTMLElement | null
  const toolInput = clickTarget?.closest?.('[data-tool-input]') as HTMLElement | null
  const toolOutput = clickTarget?.closest?.('[data-tool-output]') as HTMLElement | null
  const diffView = clickTarget?.closest?.('[data-diff]') as HTMLElement | null

  const items: MenuItem[] = [
    {
      type: 'item',
      id: 'fc-copy',
      label: 'Copy',
      onSelect: () => { if (hasSelection) document.execCommand('copy') },
      disabled: !hasSelection,
    },
    {
      type: 'item',
      id: 'fc-select-all',
      label: 'Select all',
      onSelect: () => {
        const range = document.createRange()
        if (contextElement) {
          range.selectNodeContents(contextElement)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      },
    },
  ]

  // Context-sensitive items
  if (codeBlock) {
    items.push(
      { type: 'separator', id: 'fc-code-sep' },
      {
        type: 'item',
        id: 'fc-copy-code-block',
        label: 'Copy code block',
        onSelect: () => actions.copyFreshclaudeCodeBlock(codeBlock),
      },
    )
  }

  if (toolInput) {
    const toolName = toolInput.getAttribute('data-tool-name')
    const isBash = toolName === 'Bash'
    items.push(
      { type: 'separator', id: 'fc-tool-input-sep' },
      {
        type: 'item',
        id: isBash ? 'fc-copy-command' : 'fc-copy-input',
        label: isBash ? 'Copy command' : 'Copy input',
        onSelect: () => actions.copyFreshclaudeToolInput(toolInput),
      },
    )
  }

  if (toolOutput) {
    // Don't add separator if we just added one for toolInput
    if (!toolInput) items.push({ type: 'separator', id: 'fc-tool-output-sep' })
    items.push({
      type: 'item',
      id: 'fc-copy-output',
      label: 'Copy output',
      onSelect: () => actions.copyFreshclaudeToolOutput(toolOutput),
    })
  }

  if (diffView) {
    const filePath = diffView.getAttribute('data-file-path')
    items.push(
      { type: 'separator', id: 'fc-diff-sep' },
      {
        type: 'item',
        id: 'fc-copy-new-version',
        label: 'Copy new version',
        onSelect: () => actions.copyFreshclaudeDiffNew(diffView),
      },
      {
        type: 'item',
        id: 'fc-copy-old-version',
        label: 'Copy old version',
        onSelect: () => actions.copyFreshclaudeDiffOld(diffView),
      },
    )
    if (filePath) {
      items.push({
        type: 'item',
        id: 'fc-copy-file-path',
        label: 'Copy file path',
        onSelect: () => actions.copyFreshclaudeFilePath(diffView),
      })
    }
  }

  // Session metadata at the bottom
  items.push(
    { type: 'separator', id: 'fc-session-sep' },
    { type: 'item', id: 'fc-copy-session', label: 'Copy session ID', onSelect: () => actions.copySessionId(target.sessionId) },
  )

  return items
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(context-menu): context-sensitive menu items for freshclaude chat

The menu builder now inspects clickTarget.closest() to detect what was
right-clicked and adds specialized items:
- Code block in markdown → "Copy code block"
- Bash tool input → "Copy command"
- Other tool input → "Copy input"
- Tool output → "Copy output"
- Diff view → "Copy new version", "Copy old version", "Copy file path"

Base items (Copy, Select all, Copy session ID) are always present.
```

---

### Task 6: Implement copy actions in ContextMenuProvider

**Why:** The menu items call action functions that need to actually copy content to clipboard. We need to implement `copyFreshclaudeCodeBlock`, `copyFreshclaudeToolInput`, `copyFreshclaudeToolOutput`, `copyFreshclaudeDiffNew`, `copyFreshclaudeDiffOld`, and `copyFreshclaudeFilePath`.

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (add new action callbacks)
- Modify: `src/components/context-menu/menu-defs.ts` (MenuActions type — already added in Task 2)
- Test: `test/unit/client/components/context-menu/freshclaude-chat-actions.test.ts` (new)

**Step 1: Write the failing tests**

Create `test/unit/client/components/context-menu/freshclaude-chat-actions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// These tests verify the copy logic that will live in ContextMenuProvider.
// We test the extraction functions directly since the full Provider render
// is expensive and already covered by e2e tests.

describe('freshclaude chat copy helpers', () => {
  beforeEach(() => {
    // Mock clipboard
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('copyFreshclaudeCodeBlock copies the code element textContent', async () => {
    const { copyFreshclaudeCodeBlock } = await import('@/components/context-menu/freshclaude-chat-copy')
    const code = document.createElement('code')
    code.textContent = 'const x = 1'
    await copyFreshclaudeCodeBlock(code)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const x = 1')
  })

  it('copyFreshclaudeToolInput copies the pre textContent', async () => {
    const { copyFreshclaudeToolInput } = await import('@/components/context-menu/freshclaude-chat-copy')
    const pre = document.createElement('pre')
    pre.textContent = 'echo hello'
    await copyFreshclaudeToolInput(pre)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('echo hello')
  })

  it('copyFreshclaudeToolOutput copies the pre textContent', async () => {
    const { copyFreshclaudeToolOutput } = await import('@/components/context-menu/freshclaude-chat-copy')
    const pre = document.createElement('pre')
    pre.textContent = 'file1\nfile2'
    await copyFreshclaudeToolOutput(pre)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('file1\nfile2')
  })

  it('copyFreshclaudeDiffNew extracts only added lines', async () => {
    const { copyFreshclaudeDiffNew } = await import('@/components/context-menu/freshclaude-chat-copy')
    const diff = document.createElement('div')
    // Simulate DiffView DOM: added lines have bg-green class
    const addedLine = document.createElement('div')
    addedLine.className = 'bg-green-500/10'
    const textSpan = document.createElement('span')
    textSpan.className = 'whitespace-pre'
    textSpan.textContent = 'new line'
    addedLine.appendChild(document.createElement('span')) // lineNo
    addedLine.appendChild(document.createElement('span')) // prefix
    addedLine.appendChild(textSpan)
    diff.appendChild(addedLine)

    const contextLine = document.createElement('div')
    const ctxSpan = document.createElement('span')
    ctxSpan.className = 'whitespace-pre'
    ctxSpan.textContent = 'unchanged'
    contextLine.appendChild(document.createElement('span'))
    contextLine.appendChild(document.createElement('span'))
    contextLine.appendChild(ctxSpan)
    diff.appendChild(contextLine)

    await copyFreshclaudeDiffNew(diff)
    // New version = context lines + added lines
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('new line\nunchanged')
  })

  it('copyFreshclaudeDiffOld extracts only removed lines', async () => {
    const { copyFreshclaudeDiffOld } = await import('@/components/context-menu/freshclaude-chat-copy')
    const diff = document.createElement('div')
    const removedLine = document.createElement('div')
    removedLine.className = 'bg-red-500/10'
    const textSpan = document.createElement('span')
    textSpan.className = 'whitespace-pre'
    textSpan.textContent = 'old line'
    removedLine.appendChild(document.createElement('span'))
    removedLine.appendChild(document.createElement('span'))
    removedLine.appendChild(textSpan)
    diff.appendChild(removedLine)

    const contextLine = document.createElement('div')
    const ctxSpan = document.createElement('span')
    ctxSpan.className = 'whitespace-pre'
    ctxSpan.textContent = 'unchanged'
    contextLine.appendChild(document.createElement('span'))
    contextLine.appendChild(document.createElement('span'))
    contextLine.appendChild(ctxSpan)
    diff.appendChild(contextLine)

    await copyFreshclaudeDiffOld(diff)
    // Old version = context lines + removed lines
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('old line\nunchanged')
  })

  it('copyFreshclaudeFilePath copies data-file-path attribute', async () => {
    const { copyFreshclaudeFilePath } = await import('@/components/context-menu/freshclaude-chat-copy')
    const diff = document.createElement('div')
    diff.setAttribute('data-file-path', '/tmp/test.ts')
    await copyFreshclaudeFilePath(diff)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/test.ts')
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/client/components/context-menu/freshclaude-chat-actions.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement**

Create `src/components/context-menu/freshclaude-chat-copy.ts`:

```typescript
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}

export async function copyFreshclaudeCodeBlock(el: HTMLElement | null) {
  // el is the <code> element inside <pre>; fall back to parent <pre>
  const text = el?.textContent?.trim()
  if (text) await copyText(text)
}

export async function copyFreshclaudeToolInput(el: HTMLElement | null) {
  const text = el?.textContent?.trim()
  if (text) await copyText(text)
}

export async function copyFreshclaudeToolOutput(el: HTMLElement | null) {
  const text = el?.textContent?.trim()
  if (text) await copyText(text)
}

/**
 * Extract lines from the DiffView DOM by class inspection.
 * DiffView renders each line as a div with 3 spans: [lineNo, prefix, text].
 * Added lines have a class containing 'bg-green', removed have 'bg-red'.
 */
function extractDiffLines(el: HTMLElement, include: 'new' | 'old'): string {
  const lines: string[] = []
  const divs = el.querySelectorAll('.leading-relaxed > div')
  for (const div of divs) {
    const isAdded = div.className.includes('bg-green')
    const isRemoved = div.className.includes('bg-red')
    const textSpan = div.querySelector('.whitespace-pre')
    const text = textSpan?.textContent ?? ''

    if (include === 'new') {
      // New version: context lines + added lines (skip removed)
      if (!isRemoved) lines.push(text)
    } else {
      // Old version: context lines + removed lines (skip added)
      if (!isAdded) lines.push(text)
    }
  }
  return lines.join('\n')
}

export async function copyFreshclaudeDiffNew(el: HTMLElement | null) {
  if (!el) return
  await copyText(extractDiffLines(el, 'new'))
}

export async function copyFreshclaudeDiffOld(el: HTMLElement | null) {
  if (!el) return
  await copyText(extractDiffLines(el, 'old'))
}

export async function copyFreshclaudeFilePath(el: HTMLElement | null) {
  const path = el?.getAttribute('data-file-path')
  if (path) await copyText(path)
}
```

Then wire these into `ContextMenuProvider.tsx`. Import the functions and add them to the actions object (~line 693):

```typescript
import {
  copyFreshclaudeCodeBlock,
  copyFreshclaudeToolInput,
  copyFreshclaudeToolOutput,
  copyFreshclaudeDiffNew,
  copyFreshclaudeDiffOld,
  copyFreshclaudeFilePath,
} from './freshclaude-chat-copy'
```

In the actions object:

```typescript
copyFreshclaudeCodeBlock,
copyFreshclaudeToolInput,
copyFreshclaudeToolOutput,
copyFreshclaudeDiffNew,
copyFreshclaudeDiffOld,
copyFreshclaudeFilePath,
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/client/components/context-menu/freshclaude-chat-actions.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(context-menu): implement freshclaude copy actions

Add freshclaude-chat-copy.ts with clipboard copy helpers for:
- Code blocks (textContent of <code> element)
- Tool input/output (textContent of <pre>)
- Diff new/old version (extracts added/removed lines from DiffView DOM)
- File path (from data-file-path attribute)

Wire all actions into ContextMenuProvider.
```

---

### Task 7: Full integration test — e2e right-click flow

**Why:** Verify the full flow works end-to-end: render ClaudeChatView, simulate right-click on different regions, verify correct menu items appear.

**Files:**
- Test: `test/e2e/freshclaude-context-menu-flow.test.tsx` (new)

**Step 1: Write the test**

This is an integration test that verifies the data attributes are present and the menu builder returns correct items for different click targets. Since we can't easily render the full `ContextMenuProvider` in an e2e test (it's deeply integrated into the app), we test at the boundary: verify data attributes exist on rendered components, and verify `buildMenuItems` returns the right items when given simulated click targets.

Create `test/e2e/freshclaude-context-menu-flow.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ClaudeChatView from '@/components/claude-chat/ClaudeChatView'
import claudeChatReducer, {
  sessionCreated,
  addUserMessage,
  addAssistantMessage,
  setSessionStatus,
} from '@/store/claudeChatSlice'
import panesReducer from '@/store/panesSlice'
import { buildMenuItems } from '@/components/context-menu/menu-defs'
import type { ContextTarget } from '@/components/context-menu/context-menu-types'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'

// Set up for the tests:
// 1) Render ClaudeChatView with realistic messages including tool blocks
// 2) Query the rendered DOM for data-* attributes
// 3) Feed the actual DOM elements into buildMenuItems as clickTarget
// This tests the full integration between component rendering and menu building.

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

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

const BASE_PANE: ClaudeChatPaneContent = {
  kind: 'claude-chat',
  createRequestId: 'req-1',
  sessionId: 'sess-1',
  status: 'idle',
}

function createMockActions() {
  return {
    newDefaultTab: vi.fn(), newTabWithPane: vi.fn(), copyTabNames: vi.fn(),
    toggleSidebar: vi.fn(), copyShareLink: vi.fn(), openView: vi.fn(),
    copyTabName: vi.fn(), renameTab: vi.fn(), closeTab: vi.fn(),
    closeOtherTabs: vi.fn(), closeTabsToRight: vi.fn(), moveTab: vi.fn(),
    renamePane: vi.fn(), replacePane: vi.fn(), splitPane: vi.fn(),
    resetSplit: vi.fn(), swapSplit: vi.fn(), closePane: vi.fn(),
    getTerminalActions: vi.fn(), getEditorActions: vi.fn(), getBrowserActions: vi.fn(),
    openSessionInNewTab: vi.fn(), openSessionInThisTab: vi.fn(),
    renameSession: vi.fn(), toggleArchiveSession: vi.fn(), deleteSession: vi.fn(),
    copySessionId: vi.fn(), copySessionCwd: vi.fn(), copySessionSummary: vi.fn(),
    copySessionMetadata: vi.fn(), copyResumeCommand: vi.fn(),
    setProjectColor: vi.fn(), toggleProjectExpanded: vi.fn(),
    openAllSessionsInProject: vi.fn(), copyProjectPath: vi.fn(),
    openTerminal: vi.fn(), renameTerminal: vi.fn(),
    generateTerminalSummary: vi.fn(), deleteTerminal: vi.fn(),
    copyTerminalCwd: vi.fn(), copyMessageText: vi.fn(), copyMessageCode: vi.fn(),
    copyFreshclaudeCodeBlock: vi.fn(), copyFreshclaudeToolInput: vi.fn(),
    copyFreshclaudeToolOutput: vi.fn(), copyFreshclaudeDiffNew: vi.fn(),
    copyFreshclaudeDiffOld: vi.fn(), copyFreshclaudeFilePath: vi.fn(),
  }
}

function createMockContext(actions: ReturnType<typeof createMockActions>, clickTarget: HTMLElement | null, contextElement: HTMLElement | null) {
  return {
    view: 'terminal' as const,
    sidebarCollapsed: false,
    tabs: [],
    paneLayouts: {},
    sessions: [],
    expandedProjects: new Set<string>(),
    contextElement,
    clickTarget,
    actions,
    platform: null,
  }
}

describe('freshclaude context menu integration', () => {
  afterEach(cleanup)

  it('right-click on tool input in rendered DOM produces "Copy command" menu item', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Run ls' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls -la' } },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'file1\nfile2' },
      ],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { container } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Verify data attributes are rendered
    const scrollArea = container.querySelector('[data-context="freshclaude-chat"]')!
    const toolInput = container.querySelector('[data-tool-input]')!
    expect(toolInput).not.toBeNull()
    expect(toolInput.getAttribute('data-tool-name')).toBe('Bash')

    // Feed the DOM element into buildMenuItems
    const actions = createMockActions()
    const ctx = createMockContext(actions, toolInput as HTMLElement, scrollArea as HTMLElement)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 'sess-1' }
    const items = buildMenuItems(target, ctx)

    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
    expect(ids).toContain('fc-copy-command')
    expect(ids).toContain('fc-copy-session')
  })

  it('right-click on diff in rendered DOM produces diff-specific menu items', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Edit a file' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [
        {
          type: 'tool_use', id: 'edit-1', name: 'Edit',
          input: { file_path: '/tmp/test.ts', old_string: 'const foo = 1', new_string: 'const bar = 2' },
        },
        { type: 'tool_result', tool_use_id: 'edit-1', content: 'File edited successfully' },
      ],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { container } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const scrollArea = container.querySelector('[data-context="freshclaude-chat"]')!
    const diffEl = container.querySelector('[data-diff]')!
    expect(diffEl).not.toBeNull()
    expect(diffEl.getAttribute('data-file-path')).toBe('/tmp/test.ts')

    const actions = createMockActions()
    const ctx = createMockContext(actions, diffEl as HTMLElement, scrollArea as HTMLElement)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 'sess-1' }
    const items = buildMenuItems(target, ctx)

    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-new-version')
    expect(ids).toContain('fc-copy-old-version')
    expect(ids).toContain('fc-copy-file-path')
  })
})
```

**Step 2: Run test to verify it passes (green — this is the integration verification)**

Run: `npx vitest run test/e2e/freshclaude-context-menu-flow.test.tsx`
Expected: PASS (all prior tasks should make this work)

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```
test(e2e): integration test for freshclaude context menu flow

Renders ClaudeChatView with tool blocks and diffs, queries the actual
DOM for data-* attributes, and feeds them into buildMenuItems to verify
the full pipeline: component rendering → data attributes → context-
sensitive menu items.
```

---

### Task 8: Run `npm run verify`, lint, and cleanup

**Files:** All modified files

**Step 1:** Run `npm run verify` (build + full test suite)

Expected: PASS — no type errors, all tests pass

**Step 2:** Run `npm run lint`

Fix any lint warnings in new/modified files.

**Step 3:** Review all changes for dead code, unused imports, and consistency

**Step 4: Commit** (if any fixes needed)

```
fix: lint and cleanup from freshclaude context menu implementation
```
