# Fix Tool Strip Visibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Fix two bugs where `showTools=false` hides the entire tool strip (should show collapsed summary) and `showTools=true` allows expansion (correct, but the collapsed summary should always be visible regardless).

**Architecture:** The `showTools` prop currently acts as a visibility toggle for the entire ToolStrip. It should instead control whether the user can *expand* the strip to see individual ToolBlocks. The collapsed summary line ("N tools used" / slot reel animation) is always visible. Two production files change: `MessageBubble.tsx` (always render ToolStrip, always count tool groups as visible content) and `ToolStrip.tsx` (accept `showTools` prop, lock to collapsed view when false).

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library

---

## Strategy Notes

The user's root cause analysis is correct and the fix is straightforward:

1. `MessageBubble.tsx` line 207 has `if (!showTools) return null` which hides the entire ToolStrip. This should be removed so the strip always renders.
2. `MessageBubble.tsx` line 148 has `if (group.kind === 'tools' && showTools) return true` in `hasVisibleContent`. Tool groups should always count as visible since the collapsed summary is always shown.
3. `ToolStrip.tsx` needs a `showTools` prop. When `false`: force collapsed view (ignore localStorage expanded state), hide/disable the expand chevron.
4. `MessageBubble.tsx` must pass `showTools` through to `ToolStrip`.

The browser-use test infrastructure in this project uses Python + `browser_use` library with an LLM agent -- it's a non-gating smoke test, not suited for precise UI assertions. Instead, the "visual" test will be a Vitest component-level rendering test that verifies collapsed strip visibility and chevron behavior when `showTools=false`. This is more reliable and consistent with the project's testing patterns.

---

### Task 1: Update existing tests to expect new behavior (RED)

**Files:**
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`

The following tests currently assert that tool strips are hidden when `showTools=false`. They need to be updated to assert that tool strips are *visible* (collapsed summary shown) but individual tool blocks are not expandable.

**Step 1: Update test "hides tool_use blocks when showTools is false" (line 187-197)**

Change from asserting zero tool strips to asserting the tool strip IS present with collapsed summary:

```tsx
it('shows collapsed tool strip when showTools is false', () => {
  const { container } = render(
    <MessageBubble
      role="assistant"
      content={[textBlock, toolUseBlock]}
      showTools={false}
    />
  )
  // Tool strip should still be visible (collapsed summary)
  expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
  // But no expand chevron should be available
  expect(screen.queryByRole('button', { name: /toggle tool details/i })).not.toBeInTheDocument()
})
```

**Step 2: Update test "hides tool_result blocks when showTools is false" (line 199-209)**

```tsx
it('shows collapsed tool strip for tool_result when showTools is false', () => {
  const { container } = render(
    <MessageBubble
      role="assistant"
      content={[textBlock, toolResultBlock]}
      showTools={false}
    />
  )
  // Tool strip should still be visible (collapsed summary)
  expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
})
```

**Step 3: Update test "hides entire message when all content is tools and showTools is false" (line 256-268)**

This test asserts the entire message is hidden when all content is tools and `showTools=false`. With the fix, tool groups always count as visible content, so the message should still render (showing the collapsed strip):

```tsx
it('shows collapsed strip when all content is tools and showTools is false', () => {
  const { container } = render(
    <MessageBubble
      role="assistant"
      content={[
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      ]}
      showTools={false}
    />
  )
  // Message should still render (collapsed strip is visible content)
  expect(container.querySelector('[role="article"]')).toBeInTheDocument()
  expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
})
```

**Step 4: Update test "hides message when mixed tools+thinking and both toggles are off" (line 281-294)**

With the fix, tool groups always count as visible content, so even with `showThinking=false` and `showTools=false`, a message with tools should still render:

```tsx
it('shows collapsed strip when mixed tools+thinking and both toggles are off', () => {
  const { container } = render(
    <MessageBubble
      role="assistant"
      content={[
        { type: 'thinking', thinking: 'thoughts' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ]}
      showThinking={false}
      showTools={false}
    />
  )
  // Message should still render because the collapsed tool strip is visible
  expect(container.querySelector('[role="article"]')).toBeInTheDocument()
  expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
})
```

**Step 5: Update test "hides strips when showTools is false" (line 419-433)**

```tsx
it('shows collapsed strips when showTools is false', () => {
  const { container } = render(
    <MessageBubble
      role="assistant"
      content={[
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      ]}
      showTools={false}
    />
  )
  // Tool strip should be visible (collapsed summary)
  expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
  // But no expand button
  expect(screen.queryByRole('button', { name: /toggle tool details/i })).not.toBeInTheDocument()
  expect(screen.getByText('Hello')).toBeInTheDocument()
})
```

**Step 6: Run tests to verify they fail**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx`
Expected: 5 tests FAIL (the updated assertions don't match current behavior)

---

### Task 2: Add ToolStrip test for showTools=false preventing expansion (RED)

**Files:**
- Modify: `test/unit/client/components/agent-chat/ToolStrip.test.tsx`

**Step 1: Add test that showTools=false shows collapsed view without chevron**

Add to the end of the existing `describe('ToolStrip', ...)` block:

```tsx
it('always shows collapsed view when showTools is false, even if localStorage says expanded', () => {
  localStorage.setItem(STORAGE_KEY, 'true')
  const pairs = [
    makePair('Bash', { command: 'ls' }, 'file1\nfile2'),
    makePair('Read', { file_path: '/path/file.ts' }, 'content'),
  ]
  render(<ToolStrip pairs={pairs} isStreaming={false} showTools={false} />)
  // Should show collapsed summary text
  expect(screen.getByText('2 tools used')).toBeInTheDocument()
  // Chevron toggle should NOT be rendered
  expect(screen.queryByRole('button', { name: /toggle tool details/i })).not.toBeInTheDocument()
  // Individual ToolBlocks should NOT be rendered
  expect(screen.queryByRole('button', { name: /Bash tool call/i })).not.toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npx vitest run test/unit/client/components/agent-chat/ToolStrip.test.tsx`
Expected: FAIL -- `showTools` prop doesn't exist yet on ToolStrip, and even if passed, component ignores it

**Step 3: Commit the failing tests**

```bash
cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility
git add test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/components/agent-chat/ToolStrip.test.tsx
git commit -m "test: update tool strip visibility tests for showTools behavior change (RED)"
```

---

### Task 3: Implement the fix in ToolStrip.tsx (GREEN - part 1)

**Files:**
- Modify: `src/components/agent-chat/ToolStrip.tsx`

**Step 1: Add `showTools` prop to ToolStripProps interface**

In `ToolStrip.tsx`, update the `ToolStripProps` interface (line 50-57) to add `showTools`:

```tsx
interface ToolStripProps {
  pairs: ToolPair[]
  isStreaming: boolean
  /** Index offset for this strip's completed tool blocks in the global sequence. */
  completedToolOffset?: number
  /** Completed tools at globalIndex >= this value get initialExpanded=true. */
  autoExpandAbove?: number
  /** When false, strip is locked to collapsed view (no expand chevron). Default true. */
  showTools?: boolean
}
```

**Step 2: Update ToolStrip function to use showTools prop**

Destructure `showTools = true` from props (line 59). Replace the `expanded` usage with an effective expanded state that respects `showTools`:

Change line 59 from:
```tsx
function ToolStrip({ pairs, isStreaming, completedToolOffset, autoExpandAbove }: ToolStripProps) {
```
to:
```tsx
function ToolStrip({ pairs, isStreaming, completedToolOffset, autoExpandAbove, showTools = true }: ToolStripProps) {
```

Then compute effective expanded state after line 60:
```tsx
const expandedPref = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
const expanded = showTools && expandedPref
```

Remove the existing `const expanded = useSyncExternalStore(...)` line (line 60) since it's replaced above.

**Step 3: Hide chevron button when showTools is false**

In the collapsed view (line 93-121), wrap the chevron `<button>` in a conditional so it only renders when `showTools` is true:

Change from:
```tsx
<button
  type="button"
  onClick={handleToggle}
  className="shrink-0 p-0.5 hover:bg-accent/50 rounded transition-colors"
  aria-label="Toggle tool details"
>
  <ChevronRight className="h-3 w-3" />
</button>
```

to:
```tsx
{showTools && (
  <button
    type="button"
    onClick={handleToggle}
    className="shrink-0 p-0.5 hover:bg-accent/50 rounded transition-colors"
    aria-label="Toggle tool details"
  >
    <ChevronRight className="h-3 w-3" />
  </button>
)}
```

No changes needed to the expanded view section since `expanded` will be `false` when `showTools` is `false` (the `&&` short-circuit handles it).

**Step 4: Run ToolStrip tests to verify they pass**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npx vitest run test/unit/client/components/agent-chat/ToolStrip.test.tsx`
Expected: ALL PASS (including the new `showTools=false` test)

---

### Task 4: Implement the fix in MessageBubble.tsx (GREEN - part 2)

**Files:**
- Modify: `src/components/agent-chat/MessageBubble.tsx`

**Step 1: Update `hasVisibleContent` to always count tool groups**

Change line 148 from:
```tsx
if (group.kind === 'tools' && showTools) return true
```
to:
```tsx
if (group.kind === 'tools') return true
```

This ensures messages containing only tools are still rendered (showing the collapsed strip) even when `showTools=false`.

**Step 2: Remove the early return that hides tool groups**

Remove line 207:
```tsx
if (!showTools) return null
```

**Step 3: Pass showTools prop to ToolStrip**

Update the ToolStrip rendering (lines 210-217) to pass the `showTools` prop:

Change from:
```tsx
<ToolStrip
  key={`tools-${group.startIndex}`}
  pairs={group.pairs}
  isStreaming={isStreaming}
  completedToolOffset={toolGroupOffsets[group.toolGroupIndex]}
  autoExpandAbove={autoExpandAbove}
/>
```

to:
```tsx
<ToolStrip
  key={`tools-${group.startIndex}`}
  pairs={group.pairs}
  isStreaming={isStreaming}
  completedToolOffset={toolGroupOffsets[group.toolGroupIndex]}
  autoExpandAbove={autoExpandAbove}
  showTools={showTools}
/>
```

**Step 4: Clean up `showTools` from `hasVisibleContent` dependency array**

Since `hasVisibleContent` no longer references `showTools`, remove it from the dependency array on line 151:

Change from:
```tsx
}, [groups, showThinking, showTools])
```
to:
```tsx
}, [groups, showThinking])
```

**Step 5: Run all MessageBubble tests to verify they pass**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx`
Expected: ALL PASS

**Step 6: Run the full test suite to verify no regressions**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npm test`
Expected: ALL PASS

**Step 7: Commit the production fix**

```bash
cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility
git add src/components/agent-chat/ToolStrip.tsx src/components/agent-chat/MessageBubble.tsx
git commit -m "fix: tool strip always visible, showTools controls expandability"
```

---

### Task 5: Add component-level visual verification test

**Files:**
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`

The project's browser-use tests are Python-based LLM-driven smoke tests (non-gating, non-deterministic). Instead, we add a deterministic Vitest component test that verifies the visual behavior end-to-end: rendering MessageBubble with `showTools=false`, verifying the collapsed strip is visible, and verifying clicking where the chevron would be doesn't expand.

**Step 1: Add visual verification test**

Add a new `describe` block at the end of the test file:

```tsx
describe('MessageBubble tool strip visual behavior', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
  afterEach(cleanup)

  it('renders collapsed strip with summary text when showTools is false', () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'text', text: 'Let me check that for you.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'file1.ts\nfile2.ts' },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'file1.ts' } },
          { type: 'tool_result', tool_use_id: 't2', content: 'export const x = 1' },
          { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'TODO' } },
          { type: 'tool_result', tool_use_id: 't3', content: 'No matches found' },
          { type: 'text', text: 'All looks good!' },
        ]}
        showTools={false}
      />
    )

    // The message renders
    expect(screen.getByRole('article')).toBeInTheDocument()
    // Text blocks are visible
    expect(screen.getByText('Let me check that for you.')).toBeInTheDocument()
    expect(screen.getByText('All looks good!')).toBeInTheDocument()
    // Tool strip is visible with collapsed summary
    const strips = container.querySelectorAll('[aria-label="Tool strip"]')
    expect(strips).toHaveLength(1)
    expect(screen.getByText('3 tools used')).toBeInTheDocument()
    // No expand chevron
    expect(screen.queryByRole('button', { name: /toggle tool details/i })).not.toBeInTheDocument()
    // No individual tool blocks visible
    expect(screen.queryByRole('button', { name: /Bash tool call/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Read tool call/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Grep tool call/i })).not.toBeInTheDocument()
  })

  it('renders expandable strip with chevron when showTools is true', async () => {
    const user = userEvent.setup()
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        ]}
        showTools={true}
      />
    )

    // Collapsed by default with chevron
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    const chevron = screen.getByRole('button', { name: /toggle tool details/i })
    expect(chevron).toBeInTheDocument()

    // Click to expand
    await user.click(chevron)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
  })
})
```

**Step 2: Run the test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx`
Expected: ALL PASS

**Step 3: Commit the visual verification test**

```bash
cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility
git add test/unit/client/components/agent-chat/MessageBubble.test.tsx
git commit -m "test: add visual behavior verification for tool strip visibility"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npm test`
Expected: ALL PASS

**Step 2: Run lint**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npm run lint`
Expected: No new violations

**Step 3: Run typecheck**

Run: `cd /home/user/code/freshell/.worktrees/fix-tool-strip-visibility && npx tsc --noEmit`
Expected: No type errors
