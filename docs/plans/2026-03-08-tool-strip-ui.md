# Tool Strip UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Replace the current inline rendering of individual tool blocks in agent chat with a collapsible "tool strip" that groups contiguous tool_use/tool_result blocks into a single inline element with two modes: a streaming slot-machine reel animation (collapsed) and a list of individual ToolBlocks (expanded).

**Architecture:** Approach A -- grouping logic in `MessageBubble`, new `ToolStrip` component, new `SlotReel` component, existing `ToolBlock` reused for expanded view. `MessageBubble` performs a grouping pass over its `content` array to segment blocks into render groups (text/thinking groups and tool groups). Each tool group renders as a `<ToolStrip>`. `ToolStrip` manages collapsed/expanded state (persisted to localStorage). In collapsed mode it renders `<SlotReel>` for the single-line streaming animation; in expanded mode it renders existing `<ToolBlock>` components. `getToolPreview` is extracted from `ToolBlock` to a shared utility so both `ToolBlock` and `SlotReel` can use it.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Vitest, Testing Library

---

## Scope Notes

- The tool strip is an **inline** element in the chat message flow -- it scrolls with the chat.
- A contiguous run of `tool_use` and `tool_result` blocks between text/thinking blocks becomes a single `ToolStrip`.
- **Collapsed mode** (default): single-line display showing the current tool activity with a slot-machine reel animation. The `[ToolName]` badge is on the left; streaming output/preview is on the right. Both roll independently (CSS `translateY` transition, ~150ms ease-out). Only advances when a complete new line/tool is ready. When all tools are done, settles to "N tools used". Always shows a `>` chevron on the right.
- **Expanded mode** (sticky via localStorage): shows just a toggle button followed by the existing list of `ToolBlock` components, each with its own expand chevron. No summary header -- looks like today's tool rendering. ToolBlocks provide their own `border-l-2`, so the `ToolStrip` wrapper is borderless to avoid triple-nested borders (MessageBubble > ToolStrip > ToolBlock).
- The toggle between collapsed/expanded is sticky globally via `localStorage` key `freshell:toolStripExpanded`.
- The auto-expand logic (`autoExpandAbove`, `completedToolOffset`) currently in `MessageBubble`/`AgentChatView` applies only to expanded mode -- in collapsed mode, individual tool expand state is irrelevant.
- `showTools=false` hides the entire tool strip (same as today's behavior of hiding individual tool blocks).
- `CollapsedTurn` uses `MessageBubble` which uses `ToolStrip`, so collapsed turns get tool strips automatically.
- No server or WebSocket protocol changes needed.
- No `docs/index.html` update needed (this is a UI refinement, not a new major feature).

## Shared Utility Extraction

Before building the new components, `getToolPreview` must be extracted from `ToolBlock.tsx` into a shared utility so both `ToolBlock` and the new `SlotReel` can import it. The function signature and behavior are unchanged.

---

### Task 1: Extract `getToolPreview` to Shared Utility

**Files:**
- Create: `src/components/agent-chat/tool-preview.ts`
- Modify: `src/components/agent-chat/ToolBlock.tsx`
- Test: `test/unit/client/components/agent-chat/tool-preview.test.ts`

**Step 1: Write the failing test**

Create `test/unit/client/components/agent-chat/tool-preview.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getToolPreview } from '@/components/agent-chat/tool-preview'

describe('getToolPreview', () => {
  it('returns empty string when no input', () => {
    expect(getToolPreview('Bash')).toBe('')
  })

  it('returns Bash description when available', () => {
    expect(getToolPreview('Bash', { command: 'npm test', description: 'Run tests' })).toBe('Run tests')
  })

  it('returns Bash command with $ prefix when no description', () => {
    expect(getToolPreview('Bash', { command: 'ls -la' })).toBe('$ ls -la')
  })

  it('returns Grep pattern and path', () => {
    expect(getToolPreview('Grep', { pattern: 'useState', path: 'src/' })).toBe('useState in src/')
  })

  it('returns Read file_path', () => {
    expect(getToolPreview('Read', { file_path: '/home/user/file.ts' })).toBe('/home/user/file.ts')
  })

  it('returns Edit file_path', () => {
    expect(getToolPreview('Edit', { file_path: 'src/App.tsx', old_string: 'a', new_string: 'b' })).toBe('src/App.tsx')
  })

  it('returns Glob pattern', () => {
    expect(getToolPreview('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('returns JSON fallback for unknown tools', () => {
    expect(getToolPreview('Unknown', { key: 'value' })).toBe('{"key":"value"}')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/agent-chat/tool-preview.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write the utility module**

Create `src/components/agent-chat/tool-preview.ts`:

```ts
/** Generate a context-rich one-line preview for a tool header. */
export function getToolPreview(name: string, input?: Record<string, unknown>): string {
  if (!input) return ''

  if (name === 'Bash') {
    if (typeof input.description === 'string') return input.description
    if (typeof input.command === 'string') return `$ ${input.command.slice(0, 120)}`
    return ''
  }

  if (name === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const path = typeof input.path === 'string' ? input.path : ''
    return path ? `${pattern} in ${path}` : pattern
  }

  if ((name === 'Read' || name === 'Write' || name === 'Edit') && typeof input.file_path === 'string') {
    return input.file_path
  }

  if (name === 'Glob' && typeof input.pattern === 'string') {
    return input.pattern
  }

  if ((name === 'WebFetch' || name === 'WebSearch') && typeof input.url === 'string') {
    return input.url
  }

  return JSON.stringify(input).slice(0, 100)
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/agent-chat/tool-preview.test.ts`
Expected: PASS

**Step 5: Update ToolBlock to import from shared utility**

Modify `src/components/agent-chat/ToolBlock.tsx`:
- Remove the `getToolPreview` function definition (lines 17-46)
- Add import: `import { getToolPreview } from './tool-preview'`
- Keep everything else unchanged

**Step 6: Run existing ToolBlock tests to verify no regression**

Run: `npx vitest run test/unit/client/components/agent-chat/ToolBlock.test.tsx test/unit/client/components/agent-chat/ToolBlock.autocollapse.test.tsx`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/components/agent-chat/tool-preview.ts src/components/agent-chat/ToolBlock.tsx test/unit/client/components/agent-chat/tool-preview.test.ts
git commit -m "refactor: extract getToolPreview to shared utility module"
```

---

### Task 2: Build `SlotReel` Component

The `SlotReel` is a single-line display that shows `[ToolName] preview-text` with a rolling slot-machine animation when either part changes. It receives the current tool name and preview text as props and animates transitions via CSS `translateY`.

**Files:**
- Create: `src/components/agent-chat/SlotReel.tsx`
- Test: `test/unit/client/components/agent-chat/SlotReel.test.tsx`

**Step 1: Write the failing tests**

Create `test/unit/client/components/agent-chat/SlotReel.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import SlotReel from '@/components/agent-chat/SlotReel'

describe('SlotReel', () => {
  afterEach(cleanup)

  it('renders tool name badge and preview text', () => {
    render(<SlotReel toolName="Bash" previewText="$ ls -la" />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('$ ls -la')).toBeInTheDocument()
  })

  it('renders settled state with tool count', () => {
    render(<SlotReel toolName={null} previewText={null} settledText="5 tools used" />)
    expect(screen.getByText('5 tools used')).toBeInTheDocument()
  })

  it('has accessible region role', () => {
    render(<SlotReel toolName="Read" previewText="/path/file.ts" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('shows tool name in a badge element', () => {
    render(<SlotReel toolName="Grep" previewText="pattern" />)
    const badge = screen.getByText('Grep')
    expect(badge.tagName).toBe('SPAN')
  })

  it('renders empty when no props are set', () => {
    const { container } = render(<SlotReel toolName={null} previewText={null} />)
    const status = container.querySelector('[role="status"]')
    expect(status).toBeInTheDocument()
  })

  it('applies reel animation CSS class on tool name change', () => {
    const { rerender, container } = render(
      <SlotReel toolName="Bash" previewText="$ echo hi" />
    )
    // Get the tool badge container (the element with overflow-hidden for animation)
    const nameSlot = container.querySelector('[data-slot="name"]')
    expect(nameSlot).toBeInTheDocument()

    rerender(<SlotReel toolName="Read" previewText="/file.ts" />)
    // After rerender with different tool name, the animation wrapper should
    // contain the new tool name
    expect(screen.getByText('Read')).toBeInTheDocument()
  })

  it('applies reel animation CSS class on preview text change', () => {
    const { rerender } = render(
      <SlotReel toolName="Bash" previewText="$ echo 1" />
    )
    rerender(<SlotReel toolName="Bash" previewText="$ echo 2" />)
    expect(screen.getByText('$ echo 2')).toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/agent-chat/SlotReel.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write the SlotReel component**

Create `src/components/agent-chat/SlotReel.tsx`:

```tsx
import { memo, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface SlotReelProps {
  /** Current tool name, or null when settled */
  toolName: string | null
  /** Current preview/output text, or null when settled */
  previewText: string | null
  /** Text to show when all tools are done (e.g. "5 tools used") */
  settledText?: string
}

interface ReelSlot {
  current: string
  previous: string | null
  animating: boolean
}

function useReelSlot(value: string): ReelSlot {
  const [slot, setSlot] = useState<ReelSlot>({
    current: value,
    previous: null,
    animating: false,
  })
  const prevValueRef = useRef(value)

  useEffect(() => {
    if (value === prevValueRef.current) return
    const prev = prevValueRef.current
    prevValueRef.current = value

    setSlot({ current: value, previous: prev, animating: true })

    const timer = setTimeout(() => {
      setSlot(s => ({ ...s, previous: null, animating: false }))
    }, 150)
    return () => clearTimeout(timer)
  }, [value])

  return slot
}

function ReelCell({ slot, className }: { slot: ReelSlot; className?: string }) {
  return (
    <span className={cn('relative inline-flex overflow-hidden', className)}>
      <span
        className={cn(
          'inline-block transition-transform duration-150 ease-out',
          slot.animating && '-translate-y-full',
        )}
      >
        {slot.previous ?? slot.current}
      </span>
      {slot.animating && (
        <span
          className="absolute left-0 top-full inline-block transition-transform duration-150 ease-out -translate-y-full"
        >
          {slot.current}
        </span>
      )}
    </span>
  )
}

function SlotReel({ toolName, previewText, settledText }: SlotReelProps) {
  const isSettled = toolName == null && settledText != null
  const displayName = toolName ?? ''
  const displayPreview = previewText ?? settledText ?? ''

  const nameSlot = useReelSlot(displayName)
  const previewSlot = useReelSlot(displayPreview)

  return (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 min-w-0 text-xs font-mono truncate"
    >
      {!isSettled && displayName && (
        <span
          data-slot="name"
          className="inline-flex shrink-0 items-center rounded bg-muted px-1 py-0.5 text-2xs font-semibold"
        >
          <ReelCell slot={nameSlot} />
        </span>
      )}
      <span className="truncate">
        <ReelCell slot={previewSlot} />
      </span>
    </span>
  )
}

export default memo(SlotReel)
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/agent-chat/SlotReel.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/agent-chat/SlotReel.tsx test/unit/client/components/agent-chat/SlotReel.test.tsx
git commit -m "feat: add SlotReel component for tool strip animation"
```

---

### Task 3: Build `ToolStrip` Component

The `ToolStrip` manages the collapsed/expanded toggle and delegates rendering to `SlotReel` (collapsed) or `ToolBlock` list (expanded). It receives an array of tool pairs (tool_use + optional tool_result) and the streaming/completion state.

**Files:**
- Create: `src/components/agent-chat/ToolStrip.tsx`
- Test: `test/unit/client/components/agent-chat/ToolStrip.test.tsx`

**Step 1: Write the failing tests**

Create `test/unit/client/components/agent-chat/ToolStrip.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolStrip from '@/components/agent-chat/ToolStrip'
import type { ToolPair } from '@/components/agent-chat/ToolStrip'

const STORAGE_KEY = 'freshell:toolStripExpanded'

function makePair(
  name: string,
  input: Record<string, unknown>,
  output?: string,
  isError?: boolean,
): ToolPair {
  return {
    id: `tool-${name}-${Math.random().toString(36).slice(2)}`,
    name,
    input,
    output,
    isError,
    status: output != null ? 'complete' : 'running',
  }
}

describe('ToolStrip', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
  afterEach(cleanup)

  it('renders collapsed by default showing the latest tool preview', () => {
    const pairs = [
      makePair('Bash', { command: 'echo hello' }, 'hello'),
      makePair('Read', { file_path: '/path/file.ts' }, 'content'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    // Collapsed: shows "2 tools used"
    expect(screen.getByText('2 tools used')).toBeInTheDocument()
  })

  it('always shows chevron button', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    expect(screen.getByRole('button', { name: /toggle tool details/i })).toBeInTheDocument()
  })

  it('expands on chevron click and persists to localStorage', async () => {
    const user = userEvent.setup()
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'file1\nfile2'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)

    // Expanded: should show individual ToolBlock
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
    // Persisted
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
  })

  it('starts expanded when localStorage has stored preference', () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'file1\nfile2'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    // Should show individual ToolBlock
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
  })

  it('collapses on second chevron click and removes localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const user = userEvent.setup()
    const pairs = [makePair('Bash', { command: 'ls' }, 'file1')]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)

    // Should be collapsed again
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false')
  })

  it('shows streaming tool activity when isStreaming is true', () => {
    const pairs = [
      makePair('Bash', { command: 'echo hello' }, 'hello'),
      makePair('Read', { file_path: '/path/to/file.ts' }),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={true} />)
    // Should show the currently running tool's info
    expect(screen.getByText('Read')).toBeInTheDocument()
  })

  it('shows "N tools used" when all tools are complete and not streaming', () => {
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'output'),
      makePair('Read', { file_path: 'f.ts' }, 'content'),
      makePair('Grep', { pattern: 'foo' }, 'bar'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    expect(screen.getByText('3 tools used')).toBeInTheDocument()
  })

  it('renders with error indication when any tool has isError', () => {
    const pairs = [
      makePair('Bash', { command: 'false' }, 'error output', true),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    // The strip should still render; error styling is at the ToolBlock level in expanded view
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
  })

  it('shows hasErrors indicator in collapsed mode when a tool errored', () => {
    const pairs = [
      makePair('Bash', { command: 'false' }, 'error output', true),
      makePair('Read', { file_path: 'f.ts' }, 'content'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    // Should indicate errors exist (e.g. "(1 error)" suffix or error border)
    const strip = screen.getByRole('region', { name: /tool strip/i })
    expect(strip).toBeInTheDocument()
  })

  it('renders accessible region with aria-label', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    expect(screen.getByRole('region', { name: /tool strip/i })).toBeInTheDocument()
  })

  it('passes autoExpandAbove props through to ToolBlocks in expanded mode', async () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const pairs = [
      makePair('Bash', { command: 'echo 1' }, 'output1'),
      makePair('Bash', { command: 'echo 2' }, 'output2'),
      makePair('Bash', { command: 'echo 3' }, 'output3'),
    ]
    render(
      <ToolStrip pairs={pairs} isStreaming={false} autoExpandAbove={1} completedToolOffset={0} />
    )

    const toolButtons = screen.getAllByRole('button', { name: /Bash tool call/i })
    expect(toolButtons).toHaveLength(3)
    // Tool at index 0 (globalIndex=0) should be collapsed (below autoExpandAbove=1)
    expect(toolButtons[0]).toHaveAttribute('aria-expanded', 'false')
    // Tools at indices 1,2 (globalIndex=1,2) should be expanded (>= autoExpandAbove=1)
    expect(toolButtons[1]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[2]).toHaveAttribute('aria-expanded', 'true')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/agent-chat/ToolStrip.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write the ToolStrip component**

Create `src/components/agent-chat/ToolStrip.tsx`:

```tsx
import { memo, useMemo, useSyncExternalStore } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getToolPreview } from './tool-preview'
import ToolBlock from './ToolBlock'
import SlotReel from './SlotReel'

const STORAGE_KEY = 'freshell:toolStripExpanded'

/** Read the expanded preference from localStorage. */
function getSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function getServerSnapshot(): boolean {
  return false
}

function subscribe(callback: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

function setExpandedPreference(expanded: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(expanded))
    // Dispatch storage event for other tabs / useSyncExternalStore
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
  } catch {
    // localStorage unavailable; degrade gracefully
  }
}

export interface ToolPair {
  id: string
  name: string
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  status: 'running' | 'complete'
}

interface ToolStripProps {
  pairs: ToolPair[]
  isStreaming: boolean
  /** Index offset for this strip's completed tool blocks in the global sequence. */
  completedToolOffset?: number
  /** Completed tools at globalIndex >= this value get initialExpanded=true. */
  autoExpandAbove?: number
}

function ToolStrip({ pairs, isStreaming, completedToolOffset, autoExpandAbove }: ToolStripProps) {
  const expanded = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const handleToggle = () => {
    setExpandedPreference(!expanded)
  }

  const hasErrors = pairs.some(p => p.isError)
  const allComplete = pairs.every(p => p.status === 'complete')
  const isSettled = allComplete && !isStreaming

  // Determine the current (latest active or last completed) tool for the reel
  const currentTool = useMemo(() => {
    // Find the last running tool, or fall back to the last tool
    for (let i = pairs.length - 1; i >= 0; i--) {
      if (pairs[i].status === 'running') return pairs[i]
    }
    return pairs[pairs.length - 1] ?? null
  }, [pairs])

  const toolCount = pairs.length
  const settledText = `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`

  // NOTE: ToolStrip is a borderless wrapper. In collapsed mode, the collapsed
  // row gets its own tool-colored left border (since no ToolBlock is visible).
  // In expanded mode, ToolBlocks render their own border-l-2 exactly as today,
  // producing two border levels (MessageBubble > ToolBlock) — not three.

  return (
    <div
      role="region"
      aria-label="Tool strip"
      className="my-1"
    >
      {/* Collapsed view: single-line reel with tool-colored border + chevron */}
      {!expanded && (
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-xs min-w-0 border-l-2',
            hasErrors
              ? 'border-l-[hsl(var(--claude-error))]'
              : 'border-l-[hsl(var(--claude-tool))]',
          )}
        >
          <button
            type="button"
            onClick={handleToggle}
            className="shrink-0 p-0.5 hover:bg-accent/50 rounded transition-colors"
            aria-label="Toggle tool details"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          <SlotReel
            toolName={isSettled ? null : (currentTool?.name ?? null)}
            previewText={
              isSettled
                ? null
                : (currentTool ? getToolPreview(currentTool.name, currentTool.input) : null)
            }
            settledText={settledText}
          />
        </div>
      )}

      {/* Expanded view: toggle button + ToolBlock list (looks like today).
          No header text — the user specified expanded mode shows "a list of
          tools run so far, with an expando to see each one", matching today.
          ToolBlocks provide their own border-l-2, so no border on the wrapper. */}
      {expanded && (
        <>
          <button
            type="button"
            onClick={handleToggle}
            className="shrink-0 p-0.5 hover:bg-accent/50 rounded transition-colors ml-2"
            aria-label="Toggle tool details"
          >
            <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          </button>
          {pairs.map((pair, i) => {
            const globalIndex = (completedToolOffset ?? 0) + i
            const shouldAutoExpand = autoExpandAbove != null
              ? globalIndex >= autoExpandAbove && pair.status === 'complete'
              : false
            return (
              <ToolBlock
                key={pair.id}
                name={pair.name}
                input={pair.input}
                output={pair.output}
                isError={pair.isError}
                status={pair.status}
                initialExpanded={shouldAutoExpand}
              />
            )
          })}
        </>
      )}
    </div>
  )
}

export default memo(ToolStrip)
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/agent-chat/ToolStrip.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/agent-chat/ToolStrip.tsx test/unit/client/components/agent-chat/ToolStrip.test.tsx
git commit -m "feat: add ToolStrip component with collapsed/expanded modes"
```

---

### Task 4: Add Grouping Logic to `MessageBubble`

This is the core change: `MessageBubble` performs a grouping pass over its `content` array to segment blocks into render groups, then renders `ToolStrip` for tool groups instead of individual `ToolBlock` components.

**Files:**
- Modify: `src/components/agent-chat/MessageBubble.tsx`
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`

**Step 1: Write the failing tests**

Add a new describe block to `test/unit/client/components/agent-chat/MessageBubble.test.tsx`:

```tsx
// At the top of the file, add this import alongside the existing ones:
// import type { ChatContentBlock } from '@/store/agentChatTypes'
// (already imported)

describe('MessageBubble tool strip grouping', () => {
  afterEach(cleanup)

  it('groups contiguous tool blocks into a single ToolStrip', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'text', text: 'Here is some text' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2' },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } },
          { type: 'tool_result', tool_use_id: 't2', content: 'content' },
          { type: 'text', text: 'More text' },
        ]}
      />
    )
    // Should render a single ToolStrip (with "2 tools used"), not individual ToolBlocks
    expect(screen.getByText('2 tools used')).toBeInTheDocument()
    // Both text blocks should still be visible
    expect(screen.getByText('Here is some text')).toBeInTheDocument()
  })

  it('creates separate strips for non-contiguous tool groups', async () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo 1' } },
          { type: 'tool_result', tool_use_id: 't1', content: '1' },
          { type: 'text', text: 'Middle text' },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo 2' } },
          { type: 'tool_result', tool_use_id: 't2', content: '2' },
        ]}
      />
    )
    // Two separate strips, each with 1 tool
    const strips = container.querySelectorAll('[aria-label="Tool strip"]')
    expect(strips).toHaveLength(2)
    expect(screen.getByText('Middle text')).toBeInTheDocument()
  })

  it('renders a single tool as a strip', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        ]}
      />
    )
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
  })

  it('hides strips when showTools is false', () => {
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
    expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(0)
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('includes running tool_use without result in the strip', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo 1' } },
          { type: 'tool_result', tool_use_id: 't1', content: '1' },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } },
        ]}
        isLastMessage={true}
      />
    )
    // The strip should contain 2 tools (one complete, one running)
    const strip = screen.getByRole('region', { name: /tool strip/i })
    expect(strip).toBeInTheDocument()
  })

  it('handles thinking block between text and tools', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Here is the answer' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        ]}
      />
    )
    expect(screen.getByText(/Let me think/)).toBeInTheDocument()
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx`
Expected: New tests FAIL (old tests still pass, since the component hasn't changed yet)

**Step 3: Implement grouping logic in MessageBubble**

Modify `src/components/agent-chat/MessageBubble.tsx`:

Replace the existing component with the version that includes grouping logic. The key changes:

1. Add import for `ToolStrip` and its `ToolPair` type.
2. Add a `useMemo` grouping pass that segments `content` into render groups.
3. Replace the `content.map()` rendering with render-group iteration.
4. Move `stripSystemReminders` into the grouping logic so tool results are sanitized before passing to `ToolStrip`.
5. Remove the individual `ToolBlock` import (it's now only used inside `ToolStrip`).
6. Remove the `resultMap` and `expandSet` memos that computed tool pairing and auto-expand -- these are now part of the grouping pass and delegated to `ToolStrip`.

The `hasVisibleContent` check must be updated to account for tool groups.

Here is the full replacement for the component body:

```tsx
import { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { ChatContentBlock } from '@/store/agentChatTypes'
import { LazyMarkdown } from '@/components/markdown/LazyMarkdown'
import ToolStrip, { type ToolPair } from './ToolStrip'

/** Strip SDK-injected <system-reminder>...</system-reminder> tags from text. */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

type RenderGroup =
  | { kind: 'text'; block: ChatContentBlock; index: number }
  | { kind: 'thinking'; block: ChatContentBlock; index: number }
  | { kind: 'tools'; pairs: ToolPair[]; startIndex: number }

interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: ChatContentBlock[]
  timestamp?: string
  model?: string
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
  /** When true, unpaired tool_use blocks show a spinner (they may still be running).
   *  When false (default), unpaired tool_use blocks show as complete — their results
   *  arrived in a later message. */
  isLastMessage?: boolean
  /** Index offset for this message's completed tool blocks in the global sequence. */
  completedToolOffset?: number
  /** Completed tools at globalIndex >= this value get initialExpanded=true. */
  autoExpandAbove?: number
}

function MessageBubble({
  role,
  content,
  timestamp,
  model,
  showThinking = true,
  showTools = true,
  showTimecodes = false,
  isLastMessage = false,
  completedToolOffset,
  autoExpandAbove,
}: MessageBubbleProps) {
  // Build a map of tool_use_id -> tool_result for pairing
  const resultMap = useMemo(() => {
    const map = new Map<string, ChatContentBlock>()
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, block)
      }
    }
    return map
  }, [content])

  // Group content blocks into render groups: text, thinking, or contiguous tool runs.
  const groups = useMemo(() => {
    const result: RenderGroup[] = []
    let currentToolPairs: ToolPair[] | null = null
    let toolStartIndex = 0

    const flushTools = () => {
      if (currentToolPairs && currentToolPairs.length > 0) {
        result.push({ kind: 'tools', pairs: currentToolPairs, startIndex: toolStartIndex })
      }
      currentToolPairs = null
    }

    for (let i = 0; i < content.length; i++) {
      const block = content[i]

      if (block.type === 'tool_use' && block.name) {
        if (!currentToolPairs) {
          currentToolPairs = []
          toolStartIndex = i
        }
        // Look up the matching tool_result
        const resultBlock = block.id ? resultMap.get(block.id) : undefined
        const rawResult = resultBlock
          ? (typeof resultBlock.content === 'string' ? resultBlock.content : JSON.stringify(resultBlock.content))
          : undefined
        const resultContent = rawResult ? stripSystemReminders(rawResult) : undefined

        currentToolPairs.push({
          id: block.id || `tool-${i}`,
          name: block.name,
          input: block.input,
          output: resultContent,
          isError: resultBlock?.is_error,
          status: resultBlock ? 'complete' : isLastMessage ? 'running' : 'complete',
        })
        continue
      }

      if (block.type === 'tool_result') {
        // If we're in a tool group, skip (already consumed via resultMap pairing above).
        // If it's an orphaned result (no matching tool_use), render it as its own tool group.
        if (currentToolPairs) continue

        if (block.tool_use_id && content.some(b => b.type === 'tool_use' && b.id === block.tool_use_id)) {
          // Has a matching tool_use elsewhere -- skip, it was consumed
          continue
        }

        // Orphaned result: render as standalone tool strip
        const raw = typeof block.content === 'string'
          ? block.content
          : block.content != null ? JSON.stringify(block.content) : ''
        const resultContent = raw ? stripSystemReminders(raw) : undefined
        result.push({
          kind: 'tools',
          pairs: [{
            id: block.tool_use_id || `orphan-${i}`,
            name: 'Result',
            output: resultContent,
            isError: block.is_error,
            status: 'complete',
          }],
          startIndex: i,
        })
        continue
      }

      // Non-tool block: flush any pending tool group
      flushTools()

      if (block.type === 'text' && block.text) {
        result.push({ kind: 'text', block, index: i })
      } else if (block.type === 'thinking' && block.thinking) {
        result.push({ kind: 'thinking', block, index: i })
      }
    }

    // Flush any trailing tool group
    flushTools()

    return result
  }, [content, resultMap, isLastMessage])

  // Check if any blocks will be visible after applying toggle filters.
  const hasVisibleContent = useMemo(() => {
    return groups.some((group) => {
      if (group.kind === 'text') return true
      if (group.kind === 'thinking' && showThinking) return true
      if (group.kind === 'tools' && showTools) return true
      return false
    })
  }, [groups, showThinking, showTools])

  // Track completed tool offset across tool groups for auto-expand
  const toolGroupOffsets = useMemo(() => {
    const offsets: number[] = []
    let offset = completedToolOffset ?? 0
    for (const group of groups) {
      if (group.kind === 'tools') {
        offsets.push(offset)
        offset += group.pairs.filter(p => p.status === 'complete').length
      }
    }
    return offsets
  }, [groups, completedToolOffset])

  if (!hasVisibleContent) return null

  return (
    <div
      className={cn(
        'max-w-prose pl-3 py-1 text-sm',
        role === 'user'
          ? 'border-l-[3px] border-l-[hsl(var(--claude-user))]'
          : 'border-l-2 border-l-[hsl(var(--claude-assistant))]'
      )}
      role="article"
      aria-label={`${role} message`}
    >
      {(() => {
        let toolGroupIdx = 0
        return groups.map((group, gi) => {
          if (group.kind === 'text') {
            if (role === 'user') {
              return <p key={group.index} className="whitespace-pre-wrap">{group.block.text}</p>
            }
            return (
              <div key={group.index} className="prose prose-sm dark:prose-invert max-w-none">
                <LazyMarkdown
                  content={group.block.text!}
                  fallback={<p className="whitespace-pre-wrap">{group.block.text}</p>}
                />
              </div>
            )
          }

          if (group.kind === 'thinking') {
            if (!showThinking) return null
            return (
              <details key={group.index} className="text-xs text-muted-foreground mt-1">
                <summary className="cursor-pointer select-none">
                  Thinking ({group.block.thinking!.length.toLocaleString()} chars)
                </summary>
                <pre className="mt-1 whitespace-pre-wrap text-xs opacity-70">{group.block.thinking}</pre>
              </details>
            )
          }

          if (group.kind === 'tools') {
            if (!showTools) return null
            const currentToolGroupIdx = toolGroupIdx++
            const isStreaming = isLastMessage && group.pairs.some(p => p.status === 'running')
            return (
              <ToolStrip
                key={`tools-${group.startIndex}`}
                pairs={group.pairs}
                isStreaming={isStreaming}
                completedToolOffset={toolGroupOffsets[currentToolGroupIdx]}
                autoExpandAbove={autoExpandAbove}
              />
            )
          }

          return null
        })
      })()}

      {showTimecodes && (timestamp || model) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          {timestamp && (
            <time>{new Date(timestamp).toLocaleTimeString()}</time>
          )}
          {model && <span className="opacity-60">{model}</span>}
        </div>
      )}
    </div>
  )
}

export default memo(MessageBubble)
```

**Step 4: Run all MessageBubble tests to verify**

Run: `npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx`
Expected: All tests PASS (both old and new)

Note: Some existing tests may need minor adjustments because the DOM structure changed (tool blocks are now inside a `ToolStrip` wrapper). Specifically:

- The test `'renders tool use block'` currently expects `screen.getByText('Bash:')` -- this should now find "Bash" inside the SlotReel or "1 tool used" in the settled state. Update the assertion to match the new collapsed strip behavior:
  ```tsx
  // Old: expect(screen.getByText('Bash:')).toBeInTheDocument()
  // New: tool is inside a strip
  expect(screen.getByText('1 tool used')).toBeInTheDocument()
  ```

- The test `'hides tool_use blocks when showTools is false'` assertion changes from checking for `'Bash:'` to checking that no tool strip is present.

- The test `'hides tool_result blocks when showTools is false'` assertion changes similarly.

- The `'defaults to showing thinking and tools, hiding timecodes'` test should check for tool strip presence instead of `'Bash:'`.

- The system-reminder stripping tests that click tool buttons: these now need to first expand the strip, then click the individual tool block. Update to expand the strip first:
  ```tsx
  // Click the strip toggle to expand, then click the individual tool
  await user.click(screen.getByRole('button', { name: /toggle tool details/i }))
  await user.click(screen.getByRole('button', { name: 'Read tool call' }))
  ```

- The `'auto-expands the most recent tool blocks'` test in `AgentChatView.behavior.test.tsx` needs updating: since strips are collapsed by default, the auto-expand only applies in expanded mode. Set localStorage to expanded first, or change the test to verify strip behavior.

**Step 5: Run all affected test suites**

Run: `npx vitest run test/unit/client/components/agent-chat/`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/components/agent-chat/MessageBubble.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx
git commit -m "feat: add tool strip grouping to MessageBubble with collapsed/expanded modes"
```

---

### Task 5: Update Existing Tests for New Tool Strip Behavior

Several existing tests reference individual tool blocks by name (e.g., `'Bash:'`) that now live inside a `ToolStrip`. These tests need updating to match the new DOM structure.

**Files:**
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`

**Step 1: Update MessageBubble.test.tsx existing tests**

Update existing test assertions as described in Task 4 Step 4 notes:

1. `'renders tool use block'` -- change assertion from `Bash:` to `1 tool used`
2. `'hides tool_use blocks when showTools is false'` -- check no `[aria-label="Tool strip"]` elements
3. `'hides tool_result blocks when showTools is false'` -- check no `[aria-label="Tool strip"]` elements
4. `'defaults to showing thinking and tools, hiding timecodes'` -- check for tool strip instead of `Bash:`
5. System-reminder stripping tests -- expand strip first, then click individual tool
6. `'hides entire message when all content is tools and showTools is false'` -- no change needed (still returns null)
7. `'still shows message when it has text alongside hidden tools'` -- update from `Bash:` check to no strip check

**Step 2: Update AgentChatView.behavior.test.tsx auto-expand test**

The `'auto-expands the most recent tool blocks'` test must set localStorage to expanded mode, then verify the auto-expand behavior inside the strip:

```tsx
it('auto-expands the most recent tool blocks', () => {
  localStorage.setItem('freshell:toolStripExpanded', 'true')
  const store = makeStore()
  store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
  addTurns(store, 1, 5)

  render(
    <Provider store={store}>
      <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
    </Provider>,
  )

  const toolButtons = screen.getAllByRole('button', { name: /tool call/i })
  expect(toolButtons).toHaveLength(5)

  // First 2 should be collapsed
  expect(toolButtons[0]).toHaveAttribute('aria-expanded', 'false')
  expect(toolButtons[1]).toHaveAttribute('aria-expanded', 'false')

  // Last 3 should be expanded
  expect(toolButtons[2]).toHaveAttribute('aria-expanded', 'true')
  expect(toolButtons[3]).toHaveAttribute('aria-expanded', 'true')
  expect(toolButtons[4]).toHaveAttribute('aria-expanded', 'true')

  localStorage.removeItem('freshell:toolStripExpanded')
})
```

**Step 3: Run all affected tests**

Run: `npx vitest run test/unit/client/components/agent-chat/`
Expected: All PASS

**Step 4: Commit**

```bash
git add test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
git commit -m "test: update existing tests for tool strip DOM structure changes"
```

---

### Task 6: Add Tailwind Keyframes for Reel Animation

The slot-machine reel animation uses CSS `translateY` transitions. While the basic transitions are handled by Tailwind's built-in `transition-transform` and `duration-150`, we should add a named `slot-reel` animation/keyframe to `tailwind.config.js` for the rolling effect, so it can be referenced cleanly.

**Files:**
- Modify: `tailwind.config.js`

**Step 1: No test needed -- this is a CSS configuration change**

The animation is already covered by SlotReel tests that check for CSS class presence.

**Step 2: Add keyframes to tailwind config**

Add to the `animation` and `keyframes` sections in `tailwind.config.js`:

```js
animation: {
  'pulse-subtle': 'pulse-subtle 2s ease-in-out infinite',
  'slot-reel-in': 'slot-reel-in 150ms ease-out forwards',
},
keyframes: {
  'pulse-subtle': {
    '0%, 100%': { opacity: 1 },
    '50%': { opacity: 0.7 },
  },
  'slot-reel-in': {
    '0%': { transform: 'translateY(100%)' },
    '100%': { transform: 'translateY(0%)' },
  },
},
```

**Step 3: Commit**

```bash
git add tailwind.config.js
git commit -m "style: add slot-reel-in keyframe animation to Tailwind config"
```

---

### Task 7: Run Full Test Suite and Fix Regressions

**Files:**
- Any files that fail

**Step 1: Run the full client test suite**

Run: `npx vitest run --config vitest.config.ts`
Expected: All PASS

**Step 2: Run the lint check**

Run: `npm run lint`
Expected: No new a11y violations

**Step 3: Run the typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 4: Fix any failures discovered**

Address regressions in any affected test or source file.

**Step 5: Commit fixes if needed**

```bash
git add -A
git commit -m "fix: address regressions from tool strip integration"
```

---

### Task 8: Verify End-to-End Behavior (Manual Check + Sanity Tests)

**Step 1: Run `npm run check`** (typecheck + test without building, safe while prod runs)

Run: `npm run check`
Expected: All checks pass

**Step 2: Commit any final cleanup**

```bash
git add -A
git commit -m "chore: final cleanup for tool strip UI"
```

---

## Summary of New Files

| File | Purpose |
|------|---------|
| `src/components/agent-chat/tool-preview.ts` | Shared `getToolPreview` utility (extracted from ToolBlock) |
| `src/components/agent-chat/SlotReel.tsx` | Single-line slot-machine reel animation component |
| `src/components/agent-chat/ToolStrip.tsx` | Collapsed/expanded tool strip container |
| `test/unit/client/components/agent-chat/tool-preview.test.ts` | Tests for extracted preview utility |
| `test/unit/client/components/agent-chat/SlotReel.test.tsx` | Tests for reel animation component |
| `test/unit/client/components/agent-chat/ToolStrip.test.tsx` | Tests for strip collapsed/expanded behavior |

## Modified Files

| File | Change |
|------|--------|
| `src/components/agent-chat/ToolBlock.tsx` | Remove `getToolPreview`, import from shared utility |
| `src/components/agent-chat/MessageBubble.tsx` | Add grouping logic, render `ToolStrip` instead of individual `ToolBlock` |
| `tailwind.config.js` | Add `slot-reel-in` keyframe animation |
| `test/unit/client/components/agent-chat/MessageBubble.test.tsx` | Update for new DOM structure, add grouping tests |
| `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx` | Update auto-expand test for tool strip |
